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
} from "../../src/frame.js";
import type { DataLinkSignal } from "../../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../../src/sdl/events.js";
import {
  type Ax25SessionContext,
  createSessionContext,
  modulus,
} from "../../src/sdl/session-context.js";
import { SdlSessionDriver } from "../../src/sdl/session-driver.js";
import type { TimerName, TimerScheduler } from "../../src/sdl/timer-scheduler.js";
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

  constructor(
    readonly name: string,
    readonly context: Ax25SessionContext,
    readonly driver: SdlSessionDriver,
  ) {}

  /** The current SDL state name. */
  get state(): string {
    return this.driver.currentState;
  }
}

export interface HarnessOptions {
  srej?: boolean;
  k?: number;
  t1Ms?: number;
  n2?: number;
  extended?: boolean;
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
    case "SABM":
      return "SABM_received";
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
  readonly scheduler: ManualScheduler;
  readonly t1Ms: number;

  /** When false, the drive methods skip the post-step invariant check.
   * Defaults true (oracle runs after every step). */
  checkAfterEachStep = true;

  private constructor(
    a: Endpoint,
    b: Endpoint,
    link: Link,
    scheduler: ManualScheduler,
    t1Ms: number,
  ) {
    this.a = a;
    this.b = b;
    this.link = link;
    this.scheduler = scheduler;
    this.t1Ms = t1Ms;
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
    } = opts;
    const nodeA = Callsign.parse("M0LTEA-1");
    const nodeB = Callsign.parse("M0LTEB-2");
    const scheduler = new ManualScheduler();
    const link: Link = { log: [] };

    const refs: { a?: Endpoint; b?: Endpoint } = {};
    const a = buildEndpoint(
      nodeA,
      nodeB,
      scheduler,
      link,
      () => refs.b as Endpoint,
      { srej, k, t1Ms, n2, extended },
    );
    const b = buildEndpoint(
      nodeB,
      nodeA,
      scheduler,
      link,
      () => refs.a as Endpoint,
      { srej, k, t1Ms, n2, extended },
    );
    refs.a = a;
    refs.b = b;
    a.driver.setState("Disconnected");
    b.driver.setState("Disconnected");
    return new TwoStationHarness(a, b, link, scheduler, t1Ms);
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
    // once it grew past it, stalling recovery (and masking real bugs).
    const t1 = Math.max(this.a.context.t1vMs, this.b.context.t1vMs);
    this.scheduler.advance(t1 + extraMs);
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
  opts: { srej: boolean; k: number; t1Ms: number; n2: number; extended: boolean },
): Endpoint {
  const ctx = createSessionContext(local, remote);
  ctx.k = opts.k;
  ctx.n2 = opts.n2;
  ctx.srejEnabled = opts.srej;
  ctx.isExtended = opts.extended;

  // The Endpoint is constructed last (it needs the driver), but the driver's
  // closures only *run* later, during postEvent — by which point `endpoint` is
  // assigned. Closing over a mutable reference is the standard idiom for this
  // mutual dependency. The send path routes to the *peer*; deliver appends to
  // *this* station's delivered log.
  let endpoint: Endpoint;

  const send = (frame: Ax25Frame): void => {
    // Round-trip through the wire codec so the real control byte is exercised.
    const parsed = decodeFrame(encodeFrame(frame));
    link.log.push(parsed);
    if (link.drop?.(parsed)) return;
    const target = peer();
    if (
      parsed.destination.callsign.toString() !== target.context.local.toString()
    ) {
      return;
    }
    const eventName = mapKindToEvent(classify(parsed));
    if (eventName === null) return;
    target.inbound.push({ name: eventName, frame: parsed });
  };

  const driver = new SdlSessionDriver(ctx, scheduler, {
    sendFrame: send,
    emitUpward: (sig: DataLinkSignal) => {
      if (
        sig.type === "DL_DATA_indication" ||
        sig.type === "DL_UNIT_DATA_indication"
      ) {
        endpoint.delivered.push(sig.data);
      }
    },
    // Unhandled events are SDL no-ops (events in states that don't handle them
    // are ignored); the harness never wants a throw from an inbound stray.
    onUnhandledEvent: () => {},
    freezeT1V: true,
    t1Ms: opts.t1Ms,
  });

  endpoint = new Endpoint(local.toString(), ctx, driver);
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
