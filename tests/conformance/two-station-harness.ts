/**
 * Reusable two-station conformance harness — the TypeScript analogue of
 * packet.net's `TwoStationHarness`. Two real {@link SdlSessionDriver} instances
 * run the real SDL tables over a controllable in-process link, driven by a
 * single deterministic {@link ManualScheduler} and an ordered, single-threaded
 * settle pump. The substrate for the conformance / generative-testing platform
 * (mirrors `docs/conformance-harness-plan.md` in m0lte/packet.net).
 *
 * A run is a pure function of the scenario (the sequence of {@link Submit} /
 * {@link connect} / {@link advanceT1} calls) and the channel policy
 * ({@link Link.drop}) — fully deterministic, reproducible, replayable. No
 * wall-clock anywhere.
 *
 * The harness tracks what each station *submitted* (payloads handed to
 * `DL-DATA request`) and what it *delivered* upward (`DL-DATA indication`), so
 * {@link InvariantChecker} can judge reliable in-order delivery end-to-end.
 * Every drive method runs the safety invariants after it returns (unless
 * {@link checkAfterEachStep} is cleared), so a violation is attributed to the
 * step that caused it.
 *
 * Generalised from the bespoke rig in `tests/DataLinkSrejUnderLoss.test.ts`
 * (the #8 / packet.net#231 repro), which first established the
 * `ManualScheduler` + `buildPair` + drop-filter + `settle` shape.
 *
 * ## Contention-free medium (the delayed-ack flush)
 *
 * figc4.4's in-sequence receive does `Set Ack Pending` + `LM-SEIZE Request`
 * and flushes the pending RR on `LM_SEIZE_confirm`. The library models a
 * contention-free single-session medium by granting LM-SEIZE immediately (the
 * dispatcher posts `LM_SEIZE_confirm` straight back) and the figc4.7 subroutine
 * walker makes `Enquiry Response (F = 0)` emit the acknowledging RR — so V(a)
 * advances and data transfer converges (M0LTE/ax25-ts#12, fixed). The harness
 * therefore drives the library's real ack path; data-transfer tests assert full
 * {@link assertConverged} (windows empty + complete delivery), not just the
 * reliable-delivery safety invariant.
 */
import { expect } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  decodeFrame,
  encodeFrame,
  getNs,
  isCommand as frameIsCommand,
} from "../../src/frame.js";
import type {
  DataLinkSignal,
  MdlSignal,
} from "../../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../../src/sdl/events.js";
import { Ax25ManagementDataLink } from "../../src/sdl/management-data-link.js";
import {
  type Ax25SessionContext,
  createSessionContext,
  modulus,
} from "../../src/sdl/session-context.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../../src/sdl/session-quirks.js";
import { SdlSessionDriver } from "../../src/sdl/session-driver.js";
import type { TimerName, TimerScheduler } from "../../src/sdl/timer-scheduler.js";
import type { XidParameters } from "../../src/xid.js";
import { assertConverged, checkSafety } from "./invariant-checker.js";

export const DEFAULT_T1_MS = 200;
export const DEFAULT_N2 = 12;

/** Thrown by the harness / {@link InvariantChecker} when a protocol safety or
 * liveness invariant is violated, or the link fails to settle. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolationError";
  }
}

/**
 * Deterministic scheduler — timers fire only when {@link advance} crosses their
 * deadline, never on a real-clock tick. The TS analogue of packet.net's
 * `FakeTimeProvider` + `SystemTimerScheduler`. (Same shape as the
 * `ManualScheduler` in `DataLinkSrejUnderLoss.test.ts`, lifted here so the
 * whole conformance suite shares one clock implementation.)
 */
export class ManualScheduler implements TimerScheduler {
  private nowMs = 0;
  private readonly armed = new Map<
    TimerName,
    { endMs: number; onExpiry: () => void }
  >();

  arm(name: TimerName, durationMs: number, onExpiry: () => void): void {
    this.armed.set(name, { endMs: this.nowMs + durationMs, onExpiry });
  }
  cancel(name: TimerName): void {
    this.armed.delete(name);
  }
  isRunning(name: TimerName): boolean {
    return this.armed.has(name);
  }
  timeRemainingMs(name: TimerName): number {
    const t = this.armed.get(name);
    if (!t) return 0;
    const r = t.endMs - this.nowMs;
    return r > 0 ? r : 0;
  }
  /** Advance the clock by `ms`, firing any timers whose deadline is crossed. */
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [name, t] of [...this.armed]) {
      if (t.endMs <= this.nowMs) {
        this.armed.delete(name);
        t.onExpiry();
      }
    }
  }
}

/** The in-process medium. Phase H used it deliver-only; the loss-recovery
 * phase sets {@link drop} (and, eventually, delay / reorder / duplicate /
 * corrupt policies). The TS analogue of packet.net's `TwoStationHarness.Channel`
 * (its `Drop` predicate). */
export interface Link {
  /** Return true to drop the frame at the link layer (it never reaches the
   * peer — it is still recorded in {@link log}). Undefined = clean channel.
   * Set it directly, or via {@link TwoStationHarness.dropWhen}. Mirrors
   * `Channel.Drop` in packet.net. */
  drop?: (f: Ax25Frame) => boolean;
  /** Every frame put on the wire (post round-trip through the codec), whether
   * or not it was dropped, for assertions / debugging. */
  readonly log: Ax25Frame[];
}

/** One station: its driver, context, and the submitted/delivered tracking the
 * oracle judges. */
export class Endpoint {
  /** Payloads this station submitted via DL-DATA-request, in order. */
  readonly submitted: Uint8Array[] = [];
  /** Payloads this station delivered upward (DL-DATA-indication), in order. */
  readonly delivered: Uint8Array[] = [];
  /** Inbound event queue — frames classified from the wire, pumped by settle. */
  readonly inbound: Ax25Event[] = [];
  /** Every frame this station received from its peer (post round-trip through
   * the codec, address-matched, not dropped), in order. The per-endpoint
   * analogue of {@link Link.log} (which is every frame on the wire from either
   * station). Mirrors `Endpoint.ReceivedFromPeer` in packet.net. */
  readonly receivedFromPeer: Ax25Frame[] = [];
  /** Every {@link DataLinkSignal} this station raised upward, in order — the
   * full signal log (DL-CONNECT/DISCONNECT/DATA/ERROR indications + confirms),
   * for asserting on signals other than DL-DATA-indication. Mirrors
   * `Endpoint.Signals` in packet.net. */
  readonly signals: DataLinkSignal[] = [];

  /** Every {@link MdlSignal} this station raised upward (MDL-NEGOTIATE Confirm
   * / MDL-ERROR Indicate), in order. Mirrors `Endpoint.MdlSignals`. */
  readonly mdlSignals: MdlSignal[] = [];

  /** Deferred MDL-work queue — frame deliveries destined for the MDL machine
   * are enqueued here and drained by the pump (after the data-link inbound
   * events), so an MDL reply is processed after the sender's own MDL transition
   * commits. Models the async modem boundary; mirrors `Endpoint.MdlWork`. */
  readonly mdlWork: Array<() => void> = [];

  constructor(
    readonly name: string,
    readonly context: Ax25SessionContext,
    readonly driver: SdlSessionDriver,
    /** This station's OWN deterministic timer scheduler. Each station has its
     * own — the two sessions' T1/T2/T3 are independent timers, exactly as in
     * production (every {@link Ax25Session} / {@link Ax25Listener} session
     * owns one scheduler) and in packet.net's `TwoStationHarness` (a
     * `SystemTimerScheduler` per `BuildEndpoint`, sharing only the
     * `FakeTimeProvider` clock). Sharing one scheduler across both stations
     * would let one station's `Stop T1` cancel the other's pending T1 — a
     * cross-talk that silently breaks every timeout-driven recovery. */
    readonly scheduler: ManualScheduler,
    /** This station's MDL (XID-negotiation) driver. Shares this endpoint's
     * scheduler (TM201 is a distinct timer name) and wire sink; negotiated
     * parameters mutate {@link context} — the same context the data-link runs
     * on. Mirrors `Endpoint.Mdl`. */
    readonly mdl: Ax25ManagementDataLink,
  ) {}

  /** The current SDL state name. */
  get state(): string {
    return this.driver.currentState;
  }

  /** The MDL machine's current state — `Ready` or `Negotiating`. Mirrors
   * `Endpoint.MdlState`. */
  get mdlState(): string {
    return this.mdl.state;
  }
}

export interface HarnessOptions {
  srej?: boolean;
  k?: number;
  t1Ms?: number;
  n2?: number;
  extended?: boolean;
  /** Per-session quirk toggles. Defaults to {@link defaultSessionQuirks}
   * (spec-correct). Pass {@link strictlyFaithfulSessionQuirks} (or use
   * {@link TwoStationHarness.buildStrictlyFaithful}) to run the SDL figures
   * exactly as drawn, defects and all. Mirrors the C# harness's `quirks`
   * parameter. */
  quirks?: Ax25SessionQuirks;
  /** Station A's explicit XID offer for the MDL negotiation. When omitted, the
   * MDL derives one from A's link context. Mirrors the C# harness's
   * `xidOfferA`. */
  xidOfferA?: XidParameters;
  /** Station B's explicit XID offer. Mirrors the C# harness's `xidOfferB`. */
  xidOfferB?: XidParameters;
}

function mapKindToEvent(kind: string): string | null {
  switch (kind) {
    case "I":
      return "I_received";
    case "RR":
      return "RR_received";
    case "RNR":
      return "RNR_received";
    case "REJ":
      return "REJ_received";
    case "SREJ":
      return "SREJ_received";
    case "SABM":
      return "SABM_received";
    case "SABME":
      return "SABME_received";
    case "DISC":
      return "DISC_received";
    case "UA":
      return "UA_received";
    case "DM":
      return "DM_received";
    case "UI":
      return "UI_received";
    default:
      return null;
  }
}

export class TwoStationHarness {
  readonly a: Endpoint;
  readonly b: Endpoint;
  readonly link: Link;
  readonly t1Ms: number;

  /** When false, the drive methods skip the post-step invariant check.
   * Defaults true (oracle runs after every step). */
  checkAfterEachStep = true;

  private readonly fired = new Set<string>();

  /** Every `(state, transition-id)` that has fired on either station's real
   * driver over this harness's lifetime — the substrate for behavioural
   * transition-coverage measurement. Populated from each driver's
   * `onTransitionFired` hook (the TS analogue of the C# session's
   * `TransitionFired` event). Membership is tested via {@link firedTransition};
   * exposed as a string set keyed `"<from> <id>"`. */
  get firedTransitions(): ReadonlySet<string> {
    return this.fired;
  }

  /** True if the transition `(from, id)` has fired on either station. The TS
   * analogue of `h.FiredTransitions.Should().Contain((from, id))`. */
  firedTransition(from: string, id: string): boolean {
    return this.fired.has(`${from} ${id}`);
  }

  private constructor(a: Endpoint, b: Endpoint, link: Link, t1Ms: number) {
    this.a = a;
    this.b = b;
    this.link = link;
    this.t1Ms = t1Ms;
  }

  /** Record a fired transition. Wired into each endpoint's driver as the
   * `onTransitionFired` hook by {@link build}. */
  private recordTransition(from: string, id: string): void {
    this.fired.add(`${from} ${id}`);
  }

  /**
   * Station A's timer scheduler. Each station owns its own (see
   * {@link Endpoint.scheduler}); this accessor exposes A's for the common
   * "did the submitting station arm/keep T1?" assertion. Use
   * {@link Endpoint.scheduler} directly to inspect B. The clock is advanced
   * for BOTH stations together via {@link advanceT1}.
   */
  get scheduler(): ManualScheduler {
    return this.a.scheduler;
  }

  /** The station that is not `e`. */
  peer(e: Endpoint): Endpoint {
    return e === this.a ? this.b : this.a;
  }

  // ─── Construction ───────────────────────────────────────────────────

  static build(opts: HarnessOptions = {}): TwoStationHarness {
    const {
      srej = false,
      k = 4,
      t1Ms = DEFAULT_T1_MS,
      n2 = DEFAULT_N2,
      extended = false,
      quirks = defaultSessionQuirks,
      xidOfferA,
      xidOfferB,
    } = opts;
    const nodeA = Callsign.parse("M0LTEA-1");
    const nodeB = Callsign.parse("M0LTEB-2");
    const link: Link = { log: [] };

    // One scheduler PER station — the two sessions' T1/T2/T3 are independent
    // timers. A shared scheduler would let B's `Stop T1` cancel A's pending
    // T1 (same map key), silently breaking timeout-driven recovery. Mirrors
    // packet.net's `TwoStationHarness` (a `SystemTimerScheduler` per endpoint,
    // sharing only the clock); here each `ManualScheduler` is its own clock,
    // advanced in lock-step by `advanceT1` / `recoverUntilConverged`.
    const refs: { a?: Endpoint; b?: Endpoint } = {};
    // The transition-coverage recorder routes through a mutable ref because the
    // drivers are built (with their hooks) before the harness exists — the same
    // late-binding idiom as `refs` for the peer wiring. `recordTransition` on
    // the harness fills `record` once the harness is constructed.
    const recorder: { record?: (from: string, id: string) => void } = {};
    const onTransitionFired = (
      spec: { from: string; id: string },
      _state: string,
    ): void => recorder.record?.(spec.from, spec.id);
    const a = buildEndpoint(
      nodeA,
      nodeB,
      new ManualScheduler(),
      link,
      () => refs.b as Endpoint,
      { srej, k, t1Ms, n2, extended, quirks, xidOffer: xidOfferA },
      onTransitionFired,
    );
    const b = buildEndpoint(
      nodeB,
      nodeA,
      new ManualScheduler(),
      link,
      () => refs.a as Endpoint,
      { srej, k, t1Ms, n2, extended, quirks, xidOffer: xidOfferB },
      onTransitionFired,
    );
    refs.a = a;
    refs.b = b;
    a.driver.setState("Disconnected");
    b.driver.setState("Disconnected");
    const harness = new TwoStationHarness(a, b, link, t1Ms);
    recorder.record = (from, id) => harness.recordTransition(from, id);
    return harness;
  }

  /** Build a harness whose sessions run the SDL figures exactly as drawn —
   * every {@link Ax25SessionQuirks} off. Used to pin a figure defect's faithful
   * (uncorrected) behaviour alongside the corrected default. Mirrors the C#
   * `TwoStationHarness.BuildStrictlyFaithful`. */
  static buildStrictlyFaithful(
    opts: Omit<HarnessOptions, "quirks"> = {},
  ): TwoStationHarness {
    return TwoStationHarness.build({
      ...opts,
      quirks: strictlyFaithfulSessionQuirks,
    });
  }

  // ─── Scenario actions ───────────────────────────────────────────────

  /** Establish the link from A. Asserts both reach Connected, then clears
   * connect-time tracking so delivery tracking starts clean. */
  connect(): void {
    this.connectFrom(this.a);
  }

  /** Establish the link from `initiator`. */
  connectFrom(initiator: Endpoint): void {
    initiator.driver.postEvent({ name: "DL_CONNECT_request" });
    this.pumpToQuiescence();
    if (this.a.state !== "Connected" || this.b.state !== "Connected") {
      throw new InvariantViolationError(
        `connect failed: A=${this.a.state} B=${this.b.state}`,
      );
    }
    this.a.delivered.length = 0;
    this.b.delivered.length = 0;
    this.link.log.length = 0;
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /** Mark `e` busy (DL-FLOW-OFF) — it sends RNR and the peer must stop sending
   * I-frames. Mirrors `TwoStationHarness.SetBusy` in packet.net. Depends on the
   * `ax25Spec43DlFlowOffEntersBusy` quirk (default on): figc4.4 as drawn gates
   * the busy-entering actions on the already-busy branch, so without the quirk a
   * not-busy station never enters busy here. */
  setBusy(e: Endpoint): void {
    e.driver.postEvent({ name: "DL_FLOW_OFF_request" });
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /** Clear `e`'s busy condition (DL-FLOW-ON) — it sends RR and the peer may
   * resume. Mirrors `TwoStationHarness.ClearBusy` in packet.net. */
  clearBusy(e: Endpoint): void {
    e.driver.postEvent({ name: "DL_FLOW_ON_request" });
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /** Submit one payload at `from` for its peer; records it for the
   * reliable-delivery invariant and posts DL-DATA-request. */
  submit(from: Endpoint, ...payload: number[]): void {
    const bytes = Uint8Array.from(payload);
    from.submitted.push(bytes);
    from.driver.postEvent({
      name: "DL_DATA_request",
      data: bytes,
      pid: 0xf0,
    });
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /** Disconnect from `from`; asserts both reach Disconnected. */
  disconnect(from: Endpoint): void {
    from.driver.postEvent({ name: "DL_DISCONNECT_request" });
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /**
   * Inject a received-frame event straight into `target`'s driver, then pump +
   * check. Models a frame arriving on `target`'s radio that the *peer session*
   * would never emit on its own — so it reaches received-frame transitions the
   * two well-behaved sessions can't drive between them (a FRMR, an unsolicited
   * DM, a malformed frame). Bypasses the channel's drop/address filters: the
   * frame is, by construction, "already at the receiver". Mirrors the C#
   * `TwoStationHarness.Inject`.
   */
  inject(target: Endpoint, event: Ax25Event): void {
    target.inbound.push(event);
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /**
   * Advance the clock past one T1 interval and pump to quiescence — fires any
   * due T1 timeout and lets the resulting recovery cascade settle. The TS
   * analogue of packet.net's `TwoStationHarness.AdvanceT1`: this is how a
   * loss-recovery scenario drives the timeout-driven recovery machinery
   * (figc4.5 / figc4.7 `Transmit_Enquiry` → `Invoke_Retransmission`) after the
   * channel has swallowed a frame. A loss test calls it repeatedly (see
   * {@link recoverUntilConverged}) until the link reconverges.
   */
  advanceT1(extraMs = 20): void {
    // Advance past whichever endpoint's live T1V is largest — T1V can grow
    // (figc4.7 SRT backoff), so a fixed advance could stop firing an armed T1
    // once it grew past it, stalling recovery (and masking real bugs). Both
    // stations' clocks advance together by the same amount, so a frame that
    // crosses both stations' T1 deadlines fires recovery on each — the
    // single-clock model packet.net's FakeTimeProvider gives, reconstructed
    // from two lock-stepped per-station ManualSchedulers.
    const t1 = Math.max(this.a.context.t1vMs, this.b.context.t1vMs);
    this.a.scheduler.advance(t1 + extraMs);
    this.b.scheduler.advance(t1 + extraMs);
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  // ─── MDL (XID parameter-negotiation) driving ─────────────────────────

  /**
   * Directly start an MDL XID negotiation from `e` (posts the MDL-NEGOTIATE
   * Request the data-link figc4.6 path would raise on a v2.2 connect), then
   * pump. Lets MDL tests exercise negotiation without also reproducing the full
   * SABME handshake first. Mirrors the C# `TwoStationHarness.StartNegotiation`.
   */
  startNegotiation(e: Endpoint): void {
    e.mdl.negotiate();
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  /**
   * Advance the clock past one TM201 interval (the MDL management retry timer)
   * and pump — fires a due TM201 retry / give-up and lets the cascade settle.
   * TM201 defaults to 3000 ms in the MDL driver; advance past the larger of that
   * and the live T1V so the timer fires regardless of whether the data-link has
   * (re)set T1V. Mirrors the C# `TwoStationHarness.AdvanceTm201`.
   */
  advanceTm201(extraMs = 50): void {
    const t1 = Math.max(this.a.context.t1vMs, this.b.context.t1vMs);
    const floor = 3000; // ActionDispatcher.tm201Ms default
    const step = Math.max(t1, floor) + extraMs;
    this.a.scheduler.advance(step);
    this.b.scheduler.advance(step);
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  // ─── Loss-recovery driving (the adversarial-channel surface) ─────────

  /**
   * Install a link-layer drop filter — the frame-targeted analogue of setting
   * {@link Link.drop} directly, kept symmetric with packet.net's `Link.Drop`.
   * The predicate is evaluated for every frame put on the wire (post-codec, so
   * it sees the real control byte); returning `true` drops that frame. The
   * dropped frame is still recorded in {@link Link.log}, so a test can assert a
   * targeted frame was actually dropped. Replaces any prior filter; pass
   * `undefined` to restore a clean channel. See {@link iFrameFrom} for building
   * a "drop the I-frame with N(s)=x from station Y" predicate.
   */
  dropWhen(predicate: ((f: Ax25Frame) => boolean) | undefined): void {
    this.link.drop = predicate;
  }

  /**
   * The convergence predicate — the TS analogue of packet.net
   * `LossRecoveryProperties.Converged`: both windows empty (V(s)==V(a) on each
   * side) and every submitted payload delivered in both directions. A
   * loss-recovery run is "done" when this holds; {@link assertConverged} turns
   * the same condition into a throwing assertion (with a precise message and the
   * full safety re-check).
   */
  converged(): boolean {
    return (
      this.a.context.vs === this.a.context.va &&
      this.b.context.vs === this.b.context.va &&
      this.b.delivered.length === this.a.submitted.length &&
      this.a.delivered.length === this.b.submitted.length
    );
  }

  /**
   * Drive timeout recovery to a fixed point: call {@link advanceT1} until the
   * link {@link converged | converges} or `maxRounds` is exhausted. Mirrors the
   * `for (r = 0; r < N && !Converged(h); r++) h.AdvanceT1();` loop the
   * packet.net `LossRecoveryProperties` use after a finite loss prefix. The
   * bound is the liveness watchdog — a run that does not converge within it is
   * the non-recovery bug a loss property hunts (the caller then asserts via
   * {@link assertConverged}). Returns whether it converged.
   */
  recoverUntilConverged(maxRounds: number): boolean {
    for (let r = 0; r < maxRounds && !this.converged(); r++) this.advanceT1();
    return this.converged();
  }

  /** Pump both inbound queues to quiescence (a logical "settle"), then run the
   * oracle. Use after a burst of {@link submit} to let acks settle. */
  settle(): void {
    this.pumpToQuiescence();
    if (this.checkAfterEachStep) this.checkInvariants();
  }

  // ─── Oracle ─────────────────────────────────────────────────────────

  /** Run the safety invariants (throws {@link InvariantViolationError} on the
   * first failure). */
  checkInvariants(): void {
    checkSafety(this);
  }

  /** Assert the link has fully converged: everything submitted is delivered in
   * order and both windows are empty (V(s)==V(a)). */
  assertConverged(): void {
    assertConverged(this);
  }

  // ─── Pump ───────────────────────────────────────────────────────────

  /**
   * Drain both inbound queues to quiescence. The library grants LM-SEIZE itself
   * now (the dispatcher posts `LM_SEIZE_confirm` on an `LM-SEIZE Request` — the
   * contention-free single-session model, ax25-ts#12), so the figc4.4 delayed-ack
   * RR flushes during the pump. The harness therefore no longer needs to inject
   * the confirm; if `acknowledge_pending` were ever left stuck, this loop's
   * 256-round bound surfaces it rather than papering over it.
   */
  private pumpToQuiescence(): void {
    for (let i = 0; i < 256; i++) {
      let progress = false;
      while (this.a.inbound.length > 0) {
        this.a.driver.postEvent(this.a.inbound.shift() as Ax25Event);
        progress = true;
      }
      while (this.b.inbound.length > 0) {
        this.b.driver.postEvent(this.b.inbound.shift() as Ax25Event);
        progress = true;
      }
      // Deferred MDL work (XID command/response/FRMR routed to the MDL machine)
      // — drained after the data-link events so a just-sent XID command's MDL
      // transition has committed before its reply is handled. Mirrors the C#
      // pump draining MdlWork after the data-link inbound queues.
      while (this.a.mdlWork.length > 0) {
        (this.a.mdlWork.shift() as () => void)();
        progress = true;
      }
      while (this.b.mdlWork.length > 0) {
        (this.b.mdlWork.shift() as () => void)();
        progress = true;
      }
      if (!progress) return;
    }
    throw new InvariantViolationError(
      "link did not settle within 256 round-trips — possible send/ack livelock",
    );
  }
}

function buildEndpoint(
  local: Callsign,
  remote: Callsign,
  scheduler: ManualScheduler,
  link: Link,
  peer: () => Endpoint,
  opts: {
    srej: boolean;
    k: number;
    t1Ms: number;
    n2: number;
    extended: boolean;
    quirks: Ax25SessionQuirks;
    xidOffer?: XidParameters;
  },
  onTransitionFired: (
    spec: { from: string; id: string },
    state: string,
  ) => void,
): Endpoint {
  const ctx = createSessionContext(local, remote);
  ctx.k = opts.k;
  ctx.n2 = opts.n2;
  ctx.srejEnabled = opts.srej;
  ctx.isExtended = opts.extended;
  ctx.quirks = { ...opts.quirks };

  // The Endpoint is constructed last (it needs the driver), but the driver's
  // closures only *run* later, during postEvent — by which point `endpoint` is
  // assigned. Closing over a mutable reference is the standard idiom for this
  // mutual dependency. The send path routes to the *peer*; deliver appends to
  // *this* station's delivered log.
  let endpoint: Endpoint;

  const send = (frame: Ax25Frame): void => {
    // Round-trip through the wire codec so the real control field is exercised.
    // Parse at the link's modulo: the harness is symmetric (both endpoints
    // share `extended`), and an I/S frame only ever flows once both sides agree
    // on the modulo, so the sender's modulo (ctx) equals the receiver's.
    // U frames are 1 octet in both modes regardless. Mirrors the C#
    // TwoStationHarness.SendBytes.
    const parsed = decodeFrame(encodeFrame(frame), ctx.isExtended);
    link.log.push(parsed);
    if (link.drop?.(parsed)) return;
    const target = peer();
    if (
      parsed.destination.callsign.toString() !== target.context.local.toString()
    ) {
      return;
    }
    // Delivered to the peer: record it on the peer's received log (the C#
    // `peerLocal.RxLog.Add(parsed)` after the drop + address checks).
    target.receivedFromPeer.push(parsed);

    // Mirror the listener's MDL routing (see Ax25Listener.dispatchInbound):
    //   XID command                → responder builds the XID response
    //   XID response (negotiating) → initiator applies negotiated params
    //   FRMR (negotiating)         → initiator v2.0 fallback
    //
    // MDL deliveries are DEFERRED onto the peer's work queue rather than invoked
    // synchronously: in production frames go out the modem and return through the
    // async inbound pump, so the sender's own MDL transition completes before the
    // reply is processed. Invoking synchronously here would re-enter the sender's
    // MDL postEvent mid-transition (XID command not yet committed → still in
    // Ready), mis-routing the reply. The pump drains mdlWork.
    const kind = classify(parsed);
    const peerMdl = target.mdl;
    if (kind === "XID" && frameIsCommand(parsed)) {
      target.mdlWork.push(() => peerMdl.respondToXidCommand(parsed));
      return;
    }
    if (kind === "XID" && peerMdl.isNegotiating) {
      target.mdlWork.push(() => peerMdl.onXidReceived(parsed));
      return;
    }
    if (kind === "FRMR" && peerMdl.isNegotiating) {
      target.mdlWork.push(() => peerMdl.onFrmrReceived(parsed));
      return;
    }

    const eventName = mapKindToEvent(kind);
    if (eventName === null) return;
    target.inbound.push({ name: eventName, frame: parsed });
  };

  // The MDL driver shares this endpoint's scheduler (TM201 is a distinct timer
  // name, so it doesn't collide with T1/T2/T3) and wire sink. Built before the
  // data-link driver so the data-link's MDL-NEGOTIATE-request poke (raised by
  // figc4.6 after the UA on a v2.2 connect) can route straight into it.
  // Negotiated parameters mutate ctx — the same context the data-link runs on —
  // which is the whole point. Mirrors the C# `BuildEndpoint`.
  const mdl = new Ax25ManagementDataLink(ctx, scheduler, send, opts.xidOffer);
  mdl.onMdlSignal((sig) => endpoint.mdlSignals.push(sig));

  const driver = new SdlSessionDriver(ctx, scheduler, {
    sendFrame: send,
    emitUpward: (sig: DataLinkSignal) => {
      endpoint.signals.push(sig);
      if (
        sig.type === "DL_DATA_indication" ||
        sig.type === "DL_UNIT_DATA_indication"
      ) {
        endpoint.delivered.push(sig.data);
      }
    },
    onTransitionFired,
    // Unhandled events are SDL no-ops (events in states that don't handle them
    // are ignored); the harness never wants a throw from an inbound stray.
    onUnhandledEvent: () => {},
    freezeT1V: true,
    t1Ms: opts.t1Ms,
    // The data-link figc4.6 UA-received path raises MDL-NEGOTIATE Request after
    // a successful v2.2 connect; hand it to the MDL driver to open the XID
    // exchange. Mirrors C#'s sendInternal routing to mdl.Negotiate().
    mdl: { onMdlNegotiateRequest: () => mdl.negotiate() },
  });

  endpoint = new Endpoint(local.toString(), ctx, driver, scheduler, mdl);
  return endpoint;
}

/** Outstanding (unacked) I-frame count for `e`, in mod-N arithmetic. Shared by
 * the harness and the oracle. */
export function outstanding(e: Endpoint): number {
  const m = modulus(e.context);
  return ((e.context.vs - e.context.va) % m + m) % m;
}

/**
 * Predicate matching the I-frame with the given mod-8 `ns` sourced from
 * `from` — the building block for a single-frame drop filter. Mirrors the
 * inline `f.Source.Callsign.Equals(...) && Classify(f) is IFrameReceived &&
 * f.GetIFrameNs(8) == dropPos` test in packet.net's
 * `LossRecoveryProperties.A_single_dropped_iframe_always_recovers`. Stateless;
 * compose with a `let dropped = false` latch in the caller to drop it once.
 */
export function iFrameFrom(from: Endpoint, ns: number): (f: Ax25Frame) => boolean {
  const fromCall = from.context.local.toString();
  return (f) =>
    f.source.callsign.toString() === fromCall &&
    classify(f) === "I" &&
    getNs(f) === ns;
}
