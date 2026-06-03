import type { ActionStep, Ax25ActionVerb } from "ax25sdl";
import type { Callsign } from "../callsign.js";
import {
  type Ax25Frame,
  disc,
  dm,
  getNr,
  getNs,
  iFrame,
  pollFinal as framePollFinal,
  rej,
  rnr,
  rr,
  sabm,
  sabme,
  srej,
  ua,
  ui,
} from "../frame.js";
import type { Ax25Event } from "./events.js";
import {
  type Ax25SessionContext,
  decrementSeq,
  incrementSeq,
} from "./session-context.js";
import type { SubroutineRegistry } from "./subroutine-registry.js";
import type { TimerName, TimerScheduler } from "./timer-scheduler.js";

/**
 * Carries the running state of a single transition's action chain. Each
 * verb may read fields off the triggering frame (`tx.event.frame`),
 * mutate `tx.context`, arm timers on `tx.scheduler`, accumulate fields
 * onto `tx.pending` for the next outgoing frame, or emit a frame via
 * `tx.sendFrame`.
 */
export interface TransitionContext {
  readonly context: Ax25SessionContext;
  readonly scheduler: TimerScheduler;
  readonly event: Ax25Event;
  readonly pending: PendingFrame;
  readonly sendFrame: (frame: Ax25Frame) => void;
  readonly emitUpward: (signal: DataLinkSignal) => void;
  readonly subroutines: SubroutineRegistry;
  /**
   * Inject a synthetic event back into the session driver (e.g. when an
   * I-frame pops off the queue or the driver needs to chain a derived
   * event from inside a subroutine). Returns immediately; the new event
   * is dispatched after the current action chain completes.
   */
  readonly postEvent: (event: Ax25Event) => void;
  /**
   * A stored out-of-sequence I-frame just dequeued by
   * `Retrieve Stored V(r) I Frame`, staged for the next `DL-DATA Indication`
   * to deliver. Null/undefined when the indication should deliver the
   * triggering frame instead. The figc4.4/4.5 stored-frame drain loop draws
   * retrieval and delivery as two separate actions, so a single iteration
   * stages here then delivers.
   */
  retrievedStoredFrame?: { info: Uint8Array; pid: number } | null;
}

/**
 * Mutable accumulator for fields the next outgoing frame in this chain
 * will consume. `F := P` / `N(r) := V(r)` / `F := 1` etc. populate this;
 * `RR_command` / `UA` / `I_command` read it and clear it.
 */
export interface PendingFrame {
  nr: number | null;
  ns: number | null;
  pfBit: boolean | null;
}

/** Signals that the dispatcher raises upward to the application. */
export type DataLinkSignal =
  | { type: "DL_CONNECT_indication" }
  | { type: "DL_CONNECT_confirm" }
  | { type: "DL_DISCONNECT_indication" }
  | { type: "DL_DISCONNECT_confirm" }
  | { type: "DL_DATA_indication"; data: Uint8Array; pid: number }
  | { type: "DL_UNIT_DATA_indication"; data: Uint8Array; pid: number }
  | { type: "DL_ERROR_indication"; code: string };

/**
 * Signals the management data-link (MDL) machine raises *upward* to the
 * Layer-3 entity — the `MDL-NEGOTIATE Confirm` / `MDL-ERROR Indicate (X)`
 * primitives of AX.25 v2.2 §5.1 / Appendix C5.3. Distinct from
 * {@link DataLinkSignal} (the data-link layer's upward primitives); the MDL is
 * a sibling state machine (figc5.1/figc5.2) handling only XID parameter
 * negotiation, so its primitive set is just a "negotiation complete" confirm
 * and a letter-coded error indicate. Emitted by the dispatcher when the MDL
 * machine's `signal_upper` verbs fire and forwarded to the MDL driver's
 * consumer via the {@link MdlDispatcherHooks.sendMdl} callback. Mirrors the C#
 * `MdlSignal` records.
 *
 * The error `code` is the §C5.3 management error-code letter: `"B"` —
 * unexpected XID response (received in Ready); `"C"` — management retry limit
 * exceeded (TM201/NM201 exhausted); `"D"` — XID response without F=1. (Error
 * `"A"` — XID command without P=1 — is figc5.x reception-path detail not
 * encoded by the prose bootstrap.)
 */
export type MdlSignal =
  | { type: "MDL_NEGOTIATE_confirm" }
  | { type: "MDL_ERROR_indicate"; code: string };

/**
 * MDL-specific dispatcher hooks. These are the management-data-link analogue of
 * the data-link `sendFrame` / `emitUpward` callbacks: they ride on the
 * dispatcher so the generated MDL tables can be driven through the *same*
 * {@link ActionDispatcher} the data-link uses, rather than a second
 * interpreter. They default to no-ops / the data-link semantics so a data-link
 * dispatcher built without them is unaffected; only the
 * {@link Ax25ManagementDataLink} driver wires real callbacks. Mirrors the C#
 * `ActionDispatcher`'s `sendMdl` / `sendXidCommand` / `applyNegotiatedParameters`
 * / `setVersion20` constructor hooks.
 */
export interface MdlDispatcherHooks {
  /**
   * Called when the MDL `XID_command` verb fires — build and send our XID
   * *command* frame carrying the offered parameter set (§6.3.2). The U-frame
   * factory path can't carry an info field through the dispatcher's pending
   * accumulator, so this routes through a dedicated builder the driver supplies.
   */
  readonly sendXidCommand?: (tx: TransitionContext) => void;
  /**
   * Called when the MDL `Apply Negotiated Parameters` verb fires (figc5.2) —
   * the §6.3.2 reverts-to merge of our offer and the peer's XID response.
   * Defaults to a no-op (the figc5.3–figc5.8 per-parameter subroutines are an
   * un-transcribed placeholder); the driver supplies the real merge.
   */
  readonly applyNegotiatedParameters?: (tx: TransitionContext) => void;
  /** Called when the MDL machine raises a Layer-3 signal (confirm / error). */
  readonly sendMdl?: (signal: MdlSignal) => void;
  /**
   * Called when the figc4.6 UA-received path raises the `MDL-NEGOTIATE Request`
   * internal signal on a successful v2.2 connect. The data-link listener routes
   * it to the session's MDL driver to open the XID exchange. Defaults to a
   * no-op (the legacy "XID negotiation not implemented" behaviour).
   */
  readonly onMdlNegotiateRequest?: () => void;
  /**
   * Override for the shared `set_version_2_0` verb. Defaults to the data-link
   * figc4.6 semantics (clear `isExtended` only — the data-link path runs its
   * remaining v2.0 verbs separately). The MDL driver overrides it with the
   * complete §1436 version-2.0 default set, since the figc5.2 FRMR path draws a
   * single "Set Version 2.0" box that stands in for the whole set.
   */
  readonly setVersion20?: (ctx: Ax25SessionContext) => void;
}

/**
 * Thrown when an action verb fired through the dispatcher isn't handled by any
 * case arm. With well-typed data this is now unreachable: `ActionStep.verb` is
 * the closed {@link Ax25ActionVerb} union and the dispatcher's switch is
 * exhaustive (the `never` default makes an unhandled verb a compile error), so
 * a missing case is caught by `tsc` rather than at runtime. This survives as
 * defence-in-depth for untyped runtime data that bypassed the type system
 * (e.g. a hand-built step cast to the union). The message names the verb and
 * surrounding state.
 */
export class UnknownActionError extends Error {
  constructor(verb: string, currentState: string) {
    super(
      `unknown SDL action verb '${verb}' (in state '${currentState}'). ` +
        "Add a case to ActionDispatcher.execute or extend the dispatcher.",
    );
    this.name = "UnknownActionError";
  }
}

/**
 * Executes the action chain attached to an SDL transition. Each verb maps
 * to one case arm — mutating context, arming timers, reading the incoming
 * frame, or shaping an outgoing frame via the {@link PendingFrame}
 * accumulator.
 *
 * The verb vocabulary is the closed {@link Ax25ActionVerb} union generated by
 * ax25sdl (0.8.0+), where codegen is the sole canonicaliser — every emitted
 * `ActionStep.verb` is already its one canonical spelling, so the dispatcher
 * switches on the verb directly with no runtime alias layer. The switch is
 * exhaustive: its `never` default turns a new/renamed union member with no
 * case into a `tsc` error (see {@link assertExhaustiveVerb}), so a verb can
 * never silently no-op. This is the same shape as the C# `ActionDispatcher`
 * (which folds spellings up-front via ActionVerbAliases; here the fold lives
 * in codegen instead).
 *
 * figc4.7 subroutines route through the {@link SubroutineRegistry} walker
 * once the driver has wired it (`Enquiry_Response`, `Select_T1`,
 * `Invoke_Retransmission`, `Transmit_Enquiry`, `Check_I_Frame_Acknowledged`,
 * …). A couple of high-traffic subroutines are still inlined here for the
 * happy path (`Establish_Data_Link` synthesises SABM + start_T1;
 * `Check_I_Frame_Acknowledged` runs a reduced ack-bookkeeping body), but the
 * recovery subroutines run their real figc4.7 bodies through the registry —
 * `Select_T1` does the SRT/T1V IIR (Karn-guarded via `ax25Spec41`) unless
 * {@link freezeT1V} pins T1V.
 *
 * The extended (mod-128) frame codec is wired (v2.2 arc V1, parity with
 * packet.net#266): I/S frame emission reads `ctx.isExtended` and the sequence-
 * number extraction is mode-aware (`getNs`/`getNr`/`pollFinal` read the frame's
 * own control width). One reduction relative to the C# runtime remains: the
 * driver doesn't yet *negotiate* mod-128 on its own (it doesn't flip
 * `ctx.isExtended` from an inbound SABME), so `set_version_2_2` / the SABME
 * emit path have limited effect until connected-mode negotiation lands (V4).
 */
export class ActionDispatcher {
  /**
   * If true, the SDL's SRT/T1V mutation actions are suppressed so the
   * caller-supplied T1 duration (via {@link Ax25SessionOptions.t1Ms})
   * doesn't get overwritten by `SRT := Initial Default` /
   * `T1V := 2 * SRT`. This is a TS-runtime convenience — production
   * code with full figc4.7 wiring would let the spec's RTT smoothing
   * drive T1V on its own.
   */
  freezeT1V = false;

  /**
   * Management retry timer (TM201) duration in ms — armed by the MDL machine's
   * `Start TM201` verb on each XID-command send (figc5.1/figc5.2, §C5.3). §C5.3
   * gives no numeric default for TM201; it is the management analogue of the
   * data-link T1, so it defaults to the same 3000 ms. Mirrors the C#
   * `ActionDispatcher.Tm201Duration`. Only the MDL driver arms it.
   */
  tm201Ms = 3000;

  private readonly mdl: MdlDispatcherHooks;

  constructor(
    _t1Ms: number,
    _t2Ms: number,
    private readonly t3Ms: number,
    private readonly onTimerExpiry: (name: TimerName) => void,
    /**
     * MDL (figc5.x) hooks — defaulted to no-ops / the data-link semantics so a
     * data-link dispatcher built without them is unaffected. The
     * {@link Ax25ManagementDataLink} driver supplies real callbacks.
     */
    mdl: MdlDispatcherHooks = {},
  ) {
    // T1's duration is now sourced from ctx.t1vMs on every arm — the
    // initial value is set on the context by the driver. The argument
    // is kept for symmetry with the C# dispatcher's T1Duration property.
    void _t1Ms;
    // T2's duration likewise lives on the context (`ctx.t2Ms`, set by the
    // `T2 := 3000` action). ax25sdl 0.8.0 emits no bare start_T2/stop_T2
    // verb — the canonical figures never start/stop T2 from a dispatched
    // action — so the constructor's T2 value is unused here. Kept for
    // constructor-shape symmetry with the C# dispatcher's T2Duration.
    void _t2Ms;
    this.mdl = mdl;
  }

  /**
   * Run every step in `steps` against `tx`, in order. The current state
   * name is supplied so unknown-verb errors can name the surrounding
   * state — useful for debugging "this verb was emitted in the wrong
   * state column" type bugs.
   */
  execute(
    steps: readonly ActionStep[],
    tx: TransitionContext,
    currentState: string,
  ): void {
    for (const step of steps) {
      this.executeVerb(step.verb, tx, currentState);
    }
  }

  // ─── Single-verb dispatch ────────────────────────────────────────────
  private executeVerb(
    verb: Ax25ActionVerb,
    tx: TransitionContext,
    currentState: string,
  ): void {
    const ctx = tx.context;
    const sched = tx.scheduler;

    // Quirk ax25Spec38SrejSelectiveRetransmit (default on): figc4.5 draws
    // the SREJ-received retransmit as the generic fresh-DL-DATA push +
    // go-back-N "Invoke Retransmission", contradicting §4.3.2.4/figc4.4 and
    // every implementation (packethacking/ax25spec#38). On an SREJ trigger
    // we do single-frame selective retransmit instead: redirect the push to
    // the figc4.4 "Push Old I Frame N(r) on Queue" behaviour, and skip the
    // go-back-N. Remove once ax25sdl ships a corrected figc4.5. Mirrors the
    // C# ActionDispatcher.Execute interception (m0lte/packet.net #228).
    if (
      ctx.quirks.ax25Spec38SrejSelectiveRetransmit &&
      tx.event.name === "SREJ_received"
    ) {
      switch (verb) {
        case "push_frame_on_queue":
        case "Push on I Frame Queue":
        case "Push on I Frame Queue (note: word order?)":
        case "Push I Frame on I Queue":
          // Redirect the fresh-DL-DATA push to the figc4.4 single-frame
          // selective retransmit (the N(r) frame from storage).
          pushOldIFrameNrOnQueue(tx);
          return;
        case "Invoke Retransmission":
          // Skip the go-back-N retransmission entirely.
          return;
      }
    }

    // Quirk ax25Spec42SrejTargetsGap (default on): figc4.4's out-of-sequence
    // I_received SREJ path (with a selective-reject exception already
    // outstanding) does `N(r) := N(s)` before SREJ — requesting the frame
    // that just arrived rather than the missing gap, so multi-frame SREJ
    // recovery livelocks (packethacking/ax25spec#42; direwolf flags the same
    // erratum and requests the gap). Retarget the SREJ to V(R), the next
    // still-missing frame. `N(r) := N(s)` appears only in this one I_received
    // figure path, so gating on the I_received trigger scopes the rewrite
    // precisely. Remove once ax25sdl ships a corrected figc4.4. Mirrors the
    // C# ActionDispatcher.Execute interception (m0lte/packet.net#246).
    if (
      ctx.quirks.ax25Spec42SrejTargetsGap &&
      tx.event.name === "I_received" &&
      verb === "N(r) := N(s)"
    ) {
      verb = "N(r) := V(r)";
    }

    switch (verb) {
      // ─── Flag mutations ────────────────────────────────────────────
      case "Set Own Receiver Busy":     ctx.ownReceiverBusy = true; return;
      case "Clear Own Receiver Busy":   ctx.ownReceiverBusy = false; return;
      case "set_peer_receiver_busy":    ctx.peerReceiverBusy = true; return;
      case "clear_peer_receiver_busy":  ctx.peerReceiverBusy = false; return;
      case "set_acknowledge_pending":   ctx.acknowledgePending = true; return;
      case "Clear Acknowledge Pending": ctx.acknowledgePending = false; return;
      case "Set Layer 3 Initiated":     ctx.layer3Initiated = true; return;
      case "Clear Layer 3 Initiated":   ctx.layer3Initiated = false; return;

      // ─── Timer ops ────────────────────────────────────────────────
      case "Start T1":
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      case "Start T3":                  sched.arm("T3", this.t3Ms, () => this.onTimerExpiry("T3")); return;
      case "Stop T1":
        ctx.t1RemainingWhenLastStoppedMs = sched.timeRemainingMs("T1");
        sched.cancel("T1");
        return;
      case "Stop T3":                   sched.cancel("T3"); return;

      // ─── Queue clears ─────────────────────────────────────────────
      case "discard_frame_queue":
      case "discard_I_frame_queue":
      case "Discard I Queue Entries":
      case "Discard Queue":             ctx.iFrameQueue.length = 0; return;
      case "Discard I Frame":
      case "Discard Contents of I Frame":
      case "Discard Primitive":         return; // no-op — incoming not stored anywhere

      // ─── REJ / SREJ bookkeeping ───────────────────────────────────
      case "Set Reject Exception":      ctx.rejectException = true; return;
      case "Clear Reject Condition":
      case "Clear Reject Exception":    ctx.rejectException = false; return;
      case "Clear Sreject Condition":
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        return;
      case "Increment Sreject Exception":
      case "Sreject := Sreject + 1":
        ctx.srejExceptionCount++;
        ctx.selectiveRejectException = true;
        return;
      case "Decrement Sreject Exception if > 0":
        if (ctx.srejExceptionCount > 0) {
          ctx.srejExceptionCount--;
          if (ctx.srejExceptionCount === 0) {
            ctx.selectiveRejectException = false;
          }
        }
        return;

      // ─── Clear Exception Conditions (multi-flag reset) ────────────
      case "Clear Exception Conditions":
        ctx.peerReceiverBusy = false;
        ctx.ownReceiverBusy = false;
        ctx.rejectException = false;
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        ctx.acknowledgePending = false;
        ctx.iFrameQueue.length = 0;
        return;

      // ─── Modulus / version selection ──────────────────────────────
      // set_version_2_0 is shared between the data-link figc4.6 FRMR fallback
      // and the MDL figc5.2 FRMR (pre-v2.2 peer) path. Routed through the
      // injectable setVersion20 hook: the data-link default clears isExtended
      // only (its other v2.0 verbs run separately); the MDL driver overrides it
      // to install the full §1436 v2.0 default set (the figc5.2 box stands in
      // for the whole set). Mirrors ActionDispatcher.cs.
      case "set_version_2_0":
        if (this.mdl.setVersion20) this.mdl.setVersion20(ctx);
        else ctx.isExtended = false;
        return;
      case "Set Version 2.2":           ctx.isExtended = true;  return;
      case "Modulo := 8":               ctx.isExtended = false; return;
      case "Modulo := 128":             ctx.isExtended = true;  return;
      case "Set Half Duplex":           ctx.halfDuplex = true; return;
      case "Set Implicit Reject":
        ctx.implicitReject = true;
        ctx.srejEnabled = false;
        return;
      case "Set Selective Reject":
        ctx.implicitReject = false;
        ctx.srejEnabled = true;
        return;
      case "N1 := 2048":                ctx.n1 = 2048; return;
      case "k := 8":                    ctx.k = 8; return;
      case "k := 32":                   ctx.k = 32; return;
      case "T2 := 3000":                ctx.t2Ms = 3000; return;
      case "N2 := 10":                  ctx.n2 = 10; return;

      // ─── Link-parameter assignments ───────────────────────────────
      // These can be suppressed via `freezeT1V` so a caller-supplied
      // t1Ms isn't overwritten by the spec's default-init actions.
      case "SRT := Initial Default":
        if (!this.freezeT1V) ctx.srtMs = 3000;
        return;
      case "T1V := 2 * SRT":
        if (!this.freezeT1V) ctx.t1vMs = ctx.srtMs * 2;
        return;
      case "Next T1 := 2 * SRT":
        if (!this.freezeT1V) ctx.t1vMs = ctx.srtMs * 2;
        return;
      case "Next T1 := (RC*0.25)+SRT*2":
        if (!this.freezeT1V) ctx.t1vMs = ctx.rc * 250 + ctx.srtMs * 2;
        ctx.t1HadExpired = false;
        return;
      case "SRT := 7(SRT)/8 + (T1)/8 - (Remaining Time on T1 When Last Stopped)/8": {
        // The new-sample term is (T1V − remaining_when_stopped): the elapsed
        // portion of T1 from arm to stop. It is a valid round-trip ONLY when
        // T1 was stopped by an acknowledgement of the frame that armed it —
        // i.e. it was running, so remaining > 0. On a timeout/retransmit (or
        // any reach without a fresh ack-driven stop) remaining is 0, the
        // sample degenerates to the full T1V (= 2·SRT), and since T1V derives
        // from SRT the IIR self-amplifies (SRT' = 1.125·SRT) → unbounded
        // growth → overflow. Karn's algorithm: skip the update when there is
        // no clean measurement. figc4.7 omits the guard (packethacking/
        // ax25spec#41); gated behind ax25Spec41KarnSrtSampling (default on),
        // mirroring ActionDispatcher.cs (m0lte/packet.net#241). T1V still
        // backs off via the RC term on the timeout path. `freezeT1V` (a
        // TS-runtime convenience) suppresses the whole mutation independently.
        let sample = ctx.t1vMs - ctx.t1RemainingWhenLastStoppedMs;
        if (sample < 0) sample = 0;
        const cleanMeasurement = ctx.t1RemainingWhenLastStoppedMs > 0;
        if (
          !this.freezeT1V &&
          (!ctx.quirks.ax25Spec41KarnSrtSampling || cleanMeasurement)
        ) {
          ctx.srtMs = 0.875 * ctx.srtMs + 0.125 * sample;
        }
        ctx.t1HadExpired = false;
        ctx.t1RemainingWhenLastStoppedMs = 0;
        return;
      }

      // ─── Sequence-variable assignments ────────────────────────────
      case "V(s) := 0":                 ctx.vs = 0; return;
      case "V(s) := V(s) + 1":          ctx.vs = incrementSeq(ctx, ctx.vs); return;
      case "V(r) := 0":                 ctx.vr = 0; return;
      case "V(r) := V(r) + 1":          ctx.vr = incrementSeq(ctx, ctx.vr); return;
      // figc4.5 Timer Recovery draws the stored-frame drain with V(r) := V(r) - 1.
      // Surprising for a drain; flagged upstream for spec-author review
      // (ax25sdl#49). Encoded faithfully pending that.
      case "V(r) := V(r) - 1":          ctx.vr = decrementSeq(ctx, ctx.vr); return;
      case "V(a) := 0":                 ctx.va = 0; return;
      case "RC := 0":                   ctx.rc = 0; return;
      case "RC := 1":                   ctx.rc = 1; return;
      case "RC := RC + 1":              ctx.rc++; return;
      case "V(a) := N(r)":              ctx.va = extractNr(tx); return;
      // figc4.7 Invoke_Retransmission body. `X := V(s)` snapshots the send
      // variable so the do-while loop knows where to stop; `V(s) := N(r)`
      // rewinds the send variable to the peer's N(r) so the loop re-emits from
      // the first unacked frame. Mirrors ActionDispatcher.cs (`X <- V(s)` /
      // `V(s) <- N(r)`).
      case "V(s) := N(r)":              ctx.vs = extractNr(tx); return;
      case "X := V(s)":                 ctx.x = ctx.vs; return;
      case "Backtrack":                 return; // informational marker

      // ─── Pending-frame field assignments ──────────────────────────
      case "N(r) := V(r)":             tx.pending.nr = ctx.vr; return;
      case "N(s) := V(s)":             tx.pending.ns = ctx.vs; return;
      case "N(r) := N(s)":             tx.pending.nr = extractNs(tx); return;
      case "F := 0":                   tx.pending.pfBit = false; return;
      case "F := 1":                   tx.pending.pfBit = true;  return;
      case "F := P":                   tx.pending.pfBit = extractPollFinal(tx); return;
      case "P := 0":                   tx.pending.pfBit = false; return;
      case "P := 1":                   tx.pending.pfBit = true; return;

      // ─── Supervisory-frame transmissions ──────────────────────────
      case "RR Command":
      case "RR Command (P = 0)":
        tx.sendFrame(buildSFrame(tx, "RR", true)); return;
      case "RR":
      case "RR Response":
        tx.sendFrame(buildSFrame(tx, "RR", false)); return;
      case "RNR Command":
        tx.sendFrame(buildSFrame(tx, "RNR", true)); return;
      case "RNR Response":
      case "RNR Response (F = 0)":
      case "RNR":
        tx.sendFrame(buildSFrame(tx, "RNR", false)); return;
      case "REJ":
        tx.sendFrame(buildSFrame(tx, "REJ", false)); return;
      case "SREJ":
        // figc4.4 out-of-sequence selective-reject + figc4.7 Enquiry_Response
        // SREJ paths (both emit the bare, response-form `SREJ` verb — §4.3.2.4
        // makes SREJ response-only). Emits a real SREJ supervisory frame on the
        // wire (mod-8 control 0x0D) so the peer does single-frame selective
        // retransmit of the requested gap. Mirrors the C# ActionDispatcher
        // `BuildSFrame(SupervisoryFrameType.Srej, isCommand: false, …)`.
        tx.sendFrame(buildSFrame(tx, "SREJ", false)); return;

      // ─── Unnumbered-frame transmissions ───────────────────────────
      case "UA":
      case "Expedited UA":
        tx.sendFrame(buildUFrame(tx, "UA", false, null)); return;
      case "DM":
      case "Expedited DM":
        tx.sendFrame(buildUFrame(tx, "DM", false, null)); return;
      case "DM (F = 1)":
        tx.sendFrame(buildUFrame(tx, "DM", false, true)); return;
      case "DM Response (F = 0)":
        tx.sendFrame(buildUFrame(tx, "DM", false, false)); return;
      case "SABM":
      case "SABM (P == 1)":
        tx.sendFrame(buildUFrame(tx, "SABM", true, true)); return;
      case "SABME":
      case "SABME (P = 1)":
        // figc4.7 Establish_Data_Link's `mod_128` path (and any figure column
        // that emits a bare SABME). Emits a real SABME U frame — its control
        // field is 1 octet in both modulos (Fig 4.1a/4.1b), so no extended
        // control octet. The link's subsequent I/S frames carry the 2-octet
        // extended control field (the codec wired in v2.2 arc V1). Note the
        // driver doesn't yet *originate* mod-128 on its own (it doesn't flip
        // ctx.isExtended from an inbound SABME); a test wanting an extended
        // link sets ctx.isExtended directly (as the conformance harness does),
        // and Establish_Data_Link then takes this SABME path.
        tx.sendFrame(buildUFrame(tx, "SABME", true, true)); return;
      case "DISC (P = 1)":
        tx.sendFrame(buildUFrame(tx, "DISC", true, true)); return;

      // ─── UI / I-frame transmissions ───────────────────────────────
      case "UI Command":
        tx.sendFrame(buildUiFrame(tx, true)); return;
      case "I Command":
        emitIFrame(tx); return;

      // ─── DL upper-layer signals ───────────────────────────────────
      case "DL_CONNECT_indication":     tx.emitUpward({ type: "DL_CONNECT_indication" }); return;
      case "DL_CONNECT_confirm":        tx.emitUpward({ type: "DL_CONNECT_confirm" }); return;
      case "DL_DISCONNECT_indication":  tx.emitUpward({ type: "DL_DISCONNECT_indication" }); return;
      case "DL_DISCONNECT_confirm":     tx.emitUpward({ type: "DL_DISCONNECT_confirm" }); return;
      case "DL_DATA_indication":        tx.emitUpward(buildDataIndication(tx)); return;
      case "DL_UNIT_DATA_indication":   tx.emitUpward(buildUnitDataIndication(tx)); return;
      case "DL_ERROR_indication_C_D":   tx.emitUpward({ type: "DL_ERROR_indication", code: "C_D" }); return;
      case "DL_ERROR_indication_D":     tx.emitUpward({ type: "DL_ERROR_indication", code: "D" }); return;
      case "DL-ERROR Indication (A)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "A" }); return;
      case "DL-ERROR Indication (E)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "E" }); return;
      case "DL-ERROR Indication (F)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "F" }); return;
      case "DL-ERROR Indication (G)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "G" }); return;
      case "DL-ERROR Indication (I)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "I" }); return;
      case "DL-ERROR Indication (J)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "J" }); return;
      case "DL-ERROR Indication (K)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "K" }); return;
      case "DL-ERROR Indication (L)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "L" }); return;
      case "DL-ERROR Indication (M)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "M" }); return;
      case "DL-ERROR Indication (N)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "N" }); return;
      case "DL-ERROR Indication (O)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "O" }); return;
      case "DL-ERROR Indication (Q)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "Q" }); return;
      case "DL-ERROR Indication (T)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "T" }); return;
      case "DL-ERROR Indication (U)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "U" }); return;
      case "DL-ERROR Indication (add)": tx.emitUpward({ type: "DL_ERROR_indication", code: "add" }); return;

      // ─── Link-multiplexer: seize request ─────────────────────────
      // figc4.4's in-sequence receive defers the acknowledging RR to
      // LM_SEIZE_confirm. ax25-ts has no channel-arbitration Link Multiplexer;
      // for a single contention-free session we grant the seize immediately by
      // posting LM_SEIZE_confirm straight back, which flushes the pending RR
      // (the delayed ack) so V(a) advances on the happy path. A real shared-
      // channel LM would arbitrate and pace this (T2 batching); future work.
      // (ax25-ts#12)
      case "LM_seize_request":
        tx.postEvent({ name: "LM_SEIZE_confirm" });
        return;

      // ─── Link-multiplexer: other signals (no-op in this transport model) ─
      case "LM_release_request":
      case "LM_data_request":           return;

      // ─── Internal-out signals ─────────────────────────────────────
      // figc4.6's UA-received path raises MDL-NEGOTIATE Request after a v2.2
      // connect; route it to the MDL driver (via the listener / harness hook)
      // to open the XID exchange. Defaults to a no-op when no MDL is wired (the
      // legacy "XID negotiation not implemented" behaviour). Mirrors C#'s
      // sendInternal(new MdlNegotiateRequestSignal()).
      case "MDL-NEGOTIATE Request":     this.mdl.onMdlNegotiateRequest?.(); return;

      // ─── Management Data-Link (MDL, figc5.1/figc5.2) ───────────────
      // These verbs are only ever emitted by the management_data_link machine,
      // driven by Ax25ManagementDataLink. On a data-link dispatcher the MDL
      // hooks default to no-ops / the bare timer ops, so an accidental MDL verb
      // in a data-link table is inert rather than a crash (it can't happen —
      // the tables are disjoint). Mirrors the C# ActionDispatcher MDL arms.
      //
      // XID_command (signal_lower): build + send our XID *command* frame
      // carrying the offered parameter set (§6.3.2). The U-frame factory path
      // can't carry an info field through tx.pending, so it routes through the
      // dedicated builder hook the MDL driver supplies.
      case "XID_command":               this.mdl.sendXidCommand?.(tx); return;
      // Start/Stop TM201 (figc5.x management retry timer, §C5.3). Armed on each
      // XID-command send, cancelled when negotiation completes; expiry routes
      // through onTimerExpiry("TM201") like the data-link timers, which the MDL
      // driver maps to a TM201_expiry event.
      case "Start TM201":               sched.arm("TM201", this.tm201Ms, () => this.onTimerExpiry("TM201")); return;
      case "Stop TM201":                sched.cancel("TM201"); return;
      // Apply Negotiated Parameters (figc5.2, subroutine placeholder): the
      // §6.3.2 reverts-to merge. The MDL driver supplies the real merge
      // (XidNegotiator.applyNegotiated); default is a no-op.
      case "Apply Negotiated Parameters": this.mdl.applyNegotiatedParameters?.(tx); return;
      // MDL → Layer 3 primitives (figc5.x, §5.1 / §C5.3).
      case "MDL_NEGOTIATE_confirm":     this.mdl.sendMdl?.({ type: "MDL_NEGOTIATE_confirm" }); return;
      case "MDL_ERROR_indicate_B":      this.mdl.sendMdl?.({ type: "MDL_ERROR_indicate", code: "B" }); return;
      case "MDL_ERROR_indicate_C":      this.mdl.sendMdl?.({ type: "MDL_ERROR_indicate", code: "C" }); return;
      case "MDL_ERROR_indicate_D":      this.mdl.sendMdl?.({ type: "MDL_ERROR_indicate", code: "D" }); return;

      case "push_frame_on_queue":
      case "Push on I Frame Queue":
      case "Push on I Frame Queue (note: word order?)":
      case "Push I Frame on I Queue":   pushOnIFrameQueue(tx); return;
      case "Push Old I Frame N(r) on Queue":
                                        pushOldIFrameNrOnQueue(tx); return;
      case "Push Old I Frame onto Queue":
        // figc4.7 Invoke_Retransmission body — re-send the I-frame whose
        // N(S) == V(s) (Invoke_Retransmission has just backtracked V(s) to
        // N(r) and iterates up to the original). Emit it DIRECTLY with its
        // original N(s) rather than enqueue — the fresh-frame drain would
        // renumber it to the post-loop V(s). See emitOldIFrame / #231.
        emitOldIFrame(tx, ctx.vs);
        return;

      // ─── Save / retrieve out-of-sequence I-frames ─────────────────
      case "Save Contents of I Frame":  saveIncomingIFrame(tx); return;
      case "Retrieve Stored V(r) I Frame": retrieveStoredVrIFrame(tx); return;

      // ─── Subroutine calls ──────────────────────────────────────────
      // The subroutine registry handles dispatch; in our TS port the
      // registry's default impl is a no-op logger (figc4.7 not walked).
      // Inlined subroutines for the happy path:
      //   - Establish_Data_Link: clear exceptions, RC<-1, P<-1, send
      //     SABM(P=1), stop_T3, start_T1
      //   - Select_T1_Value: no-op (we don't dynamically tune T1V)
      case "Establish_Data_Link":
        ctx.peerReceiverBusy = false;
        ctx.ownReceiverBusy = false;
        ctx.rejectException = false;
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        ctx.acknowledgePending = false;
        ctx.iFrameQueue.length = 0;
        ctx.rc = 1;
        tx.pending.pfBit = true;
        // figc4.7 Establish_Data_Link has two guarded paths: `mod_128` emits
        // SABME, `not mod_128` emits SABM. Honour the session's negotiated
        // modulo so an extended link comes up via SABME (the peer's
        // SABME_received arm then keeps mod-128 via `Set Version 2.2`), rather
        // than SABM (which would flip the peer back to mod-8 via
        // `set_version_2_0`).
        tx.sendFrame(buildUFrame(tx, ctx.isExtended ? "SABME" : "SABM", true, true));
        sched.cancel("T3");
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      case "UI Check":
        // TODO: figc4.7 UI_Check subroutine — surface incoming UI as
        // DL-UNIT-DATA. Out of scope until UI handling is wired top to
        // bottom.
        return;
      case "Check_I_Frame_Acknowledged": {
        // Inline a reduced version of figc4.7 Check_I_Frame_Acknowledged:
        // when N(R) advances acknowledgements, update V(a), restart T1
        // if needed. Our happy-path needs are:
        //   * peer not busy + N(R) == V(s): caught up — V(a) := N(r),
        //     stop_T1, start_T3.
        //   * partial ack with progress: V(a) := N(r), restart T1.
        //   * else: no change.
        const trigger = tx.event;
        if (!trigger.frame) return;
        const nr = getNr(trigger.frame);
        if (ctx.peerReceiverBusy) {
          ctx.va = nr;
          sched.cancel("T3");
          if (!sched.isRunning("T1")) {
            sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
          }
          return;
        }
        if (nr === ctx.vs) {
          ctx.va = nr;
          ctx.t1RemainingWhenLastStoppedMs = sched.timeRemainingMs("T1");
          sched.cancel("T1");
          sched.arm("T3", this.t3Ms, () => this.onTimerExpiry("T3"));
          return;
        }
        if (nr === ctx.va) {
          // No progress.
          return;
        }
        // Partial ack with progress.
        ctx.va = nr;
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      }
      // ─── Subroutine calls routed through the registry ──────────────
      // ax25sdl 0.8.0 emits each subroutine-call verb in one canonical
      // spelling (codegen is the sole canonicaliser). The figc4.x state pages
      // spell the call figure-verbatim (e.g. "Invoke Retransmission" with a
      // space), while the figc4.7 SubroutineSpec entries key off the
      // underscore name ("Invoke_Retransmission"). The
      // {@link DefaultSubroutineRegistry} owns subroutine-name resolution
      // (spec names + its own LEGACY/CONTEXT-binding alias tables — a distinct
      // concern from verb canonicalisation), so each arm hands it the name it
      // resolves: the underscore spec name for the spaced figure spellings, or
      // the registry alias key for the F-bit-binding / legacy-named calls.
      // Mirrors ActionDispatcher.cs passing the canonical underscore literal to
      // subroutines.Invoke. The registry's own onUnknown handles a genuinely
      // unregistered name.
      case "Check Need For Response":
        tx.subroutines.invoke("Check_Need_For_Response", tx); return;
      case "Transmit Enquiry":
      case "Transmit Enquery":
        tx.subroutines.invoke("Transmit_Enquiry", tx); return;
      case "Invoke Retransmission":
        tx.subroutines.invoke("Invoke_Retransmission", tx); return;
      case "N(r) Error Recovery":
      case "N(r) Recovery":
        tx.subroutines.invoke("N_r_Error_Recovery", tx); return;
      // Direct registry alias keys: "Enquiry Response (F = 0)" and
      // "Enquiry_Response_F_1" are CONTEXT_BINDING_ALIASES (they bind the
      // reply's F bit then walk Enquiry_Response); "Select_T1_Value" is a
      // LEGACY_ALIAS for Select_T1. Pass each through verbatim.
      case "Enquiry Response (F = 0)":
      case "Enquiry_Response_F_1":
      case "Select_T1_Value":
        tx.subroutines.invoke(verb, tx); return;

      default:
        // Exhaustiveness guard. ax25sdl 0.8.0 canonicalises every emitted
        // verb at codegen time and types `ActionStep.verb` as the closed
        // {@link Ax25ActionVerb} union, so every member must be handled
        // above. If a new/renamed verb lands in a future ax25sdl bump with no
        // case here, `verb` is no longer `never` and `tsc` fails this
        // assignment — a compile error, not a silent runtime no-op. The throw
        // is defence-in-depth for untyped runtime data (e.g. a hand-built
        // step cast to the union) and preserves {@link UnknownActionError}.
        return assertExhaustiveVerb(verb, currentState);
    }
  }
}

/**
 * Compile-time exhaustiveness check for the {@link Ax25ActionVerb} switch in
 * {@link ActionDispatcher.executeVerb}. Reached only if a `verb` slips past
 * every case arm; if the union and the switch agree, `verb` narrows to `never`
 * here and the parameter assignment typechecks. A new/renamed union member
 * with no case widens `verb` away from `never`, so `tsc` rejects the call —
 * forcing a case to be added rather than the verb silently no-op'ing at
 * runtime. At runtime (only with untyped data that bypassed the type system)
 * it throws {@link UnknownActionError}.
 */
function assertExhaustiveVerb(verb: never, currentState: string): never {
  throw new UnknownActionError(verb as string, currentState);
}

// ─── Frame-emission helpers ────────────────────────────────────────────

/**
 * Return the trigger's inbound digipeater chain reversed, or an empty
 * array if the trigger has no inbound frame / no digipeaters. The wire
 * shape of an outbound response to a digipeated inbound frame uses the
 * inbound chain reversed so the digipeater closest to the responder is
 * the first hop (AX.25 v2.2 §C.2 Path Construction): inbound SABM via
 * `[digi1, digi2]` → outbound UA via `[digi2, digi1]`.
 *
 * Mirrors `ActionDispatcher.ReversedTriggerPath` from the C# runtime
 * (PR #141). Returns an empty array (not null) since the frame
 * factories accept a `digipeaters` chain field unconditionally.
 */
function reversedTriggerPath(tx: TransitionContext): Callsign[] {
  const frame = tx.event.frame;
  if (!frame || frame.digipeaters.length === 0) return [];
  const reversed: Callsign[] = [];
  for (let i = frame.digipeaters.length - 1; i >= 0; i--) {
    reversed.push(frame.digipeaters[i]!.callsign);
  }
  return reversed;
}

function buildSFrame(
  tx: TransitionContext,
  type: "RR" | "RNR" | "REJ" | "SREJ",
  isCommand: boolean,
): Ax25Frame {
  const ctx = tx.context;
  const nr = tx.pending.nr ?? ctx.vr;
  const pf = tx.pending.pfBit ?? false;
  const opts = {
    destination: ctx.remote,
    source: ctx.local,
    digipeaters: reversedTriggerPath(tx),
    nr,
    isCommand,
    pollFinal: pf,
    // Emit the 2-octet extended control field when the session negotiated
    // mod-128 (Fig 4.3b). Mirrors the C# FrameSpecExtensions passing
    // context.IsExtended.
    extended: ctx.isExtended,
  };
  if (type === "RR") return rr(opts);
  if (type === "RNR") return rnr(opts);
  if (type === "SREJ") return srej(opts);
  return rej(opts);
}

function buildUFrame(
  tx: TransitionContext,
  type: "SABM" | "SABME" | "DISC" | "UA" | "DM",
  _isCommand: boolean,
  pfOverride: boolean | null,
): Ax25Frame {
  const ctx = tx.context;
  const pf = pfOverride ?? tx.pending.pfBit ?? false;
  const factoryOpts = {
    destination: ctx.remote,
    source: ctx.local,
    digipeaters: reversedTriggerPath(tx),
  };
  if (type === "SABM") return sabm({ ...factoryOpts, pollBit: pf });
  if (type === "SABME") return sabme({ ...factoryOpts, pollBit: pf });
  if (type === "DISC") return disc({ ...factoryOpts, pollBit: pf });
  if (type === "UA") return ua({ ...factoryOpts, finalBit: pf });
  return dm({ ...factoryOpts, finalBit: pf });
}

function buildUiFrame(tx: TransitionContext, isCommand: boolean): Ax25Frame {
  const ctx = tx.context;
  if (!tx.event.data) {
    throw new Error(
      "action `UI_command` requires the trigger to be DL_UNIT_DATA_request " +
        `(with attached data), but the trigger '${tx.event.name}' has no payload.`,
    );
  }
  return ui({
    destination: ctx.remote,
    source: ctx.local,
    digipeaters: reversedTriggerPath(tx),
    info: tx.event.data,
    pid: tx.event.pid,
    isCommand,
    pollFinal: tx.pending.pfBit ?? false,
  });
}

function emitIFrame(tx: TransitionContext): void {
  const ctx = tx.context;
  if (!tx.event.data) {
    throw new Error(
      "action `I_command` requires the trigger to be I_frame_pops_off_queue " +
        `(with attached payload), but the trigger '${tx.event.name}' has no payload.`,
    );
  }
  const ns = tx.pending.ns ?? ctx.vs;
  const nr = tx.pending.nr ?? ctx.vr;
  const pf = tx.pending.pfBit ?? false;
  const frame = iFrame({
    destination: ctx.remote,
    source: ctx.local,
    digipeaters: reversedTriggerPath(tx),
    nr,
    ns,
    info: tx.event.data,
    pid: tx.event.pid,
    pollBit: pf,
    extended: ctx.isExtended,
  });
  tx.sendFrame(frame);
  ctx.sentIFrames.set(ns, { data: tx.event.data, pid: tx.event.pid ?? 0xf0 });
}

function pushOnIFrameQueue(tx: TransitionContext): void {
  if (tx.event.name !== "DL_DATA_request" || !tx.event.data) {
    throw new Error(
      `action 'push_on_I_frame_queue' requires DL_DATA_request trigger, got '${tx.event.name}'.`,
    );
  }
  tx.context.iFrameQueue.push({
    data: tx.event.data,
    pid: tx.event.pid ?? 0xf0,
  });
}

/**
 * Implements `Push Old I Frame N(r) on Queue` (figc4.4's selective SREJ/REJ
 * retransmit): re-send the previously-sent I-frame whose N(S) equals the
 * incoming frame's N(R). Emits directly via {@link emitOldIFrame} — see the
 * note there for why a retransmit must NOT be routed through the fresh-frame
 * queue. Also the figc4.4/figc4.5 SREJ-quirk redirect target.
 */
function pushOldIFrameNrOnQueue(tx: TransitionContext): void {
  emitOldIFrame(tx, extractNr(tx));
}

/**
 * Re-transmit a previously-sent I-frame, preserving its ORIGINAL N(s).
 * Shared by figc4.4's selective SREJ/REJ recovery
 * (`Push Old I Frame N(r) on Queue`) and figc4.7's go-back-N
 * `Invoke_Retransmission` loop (`Push Old I Frame onto Queue`).
 *
 * Emits directly via `tx.sendFrame` rather than via
 * {@link Ax25SessionContext.iFrameQueue}: the queue + fresh-frame drain
 * (figc4.4 t03 "I frame pops off queue") assigns `N(s) := V(s)` and increments
 * V(s) — correct for a *fresh* frame, but it renumbers a *retransmitted* one to
 * the current V(s), so the peer never sees the missing sequence number and the
 * gap never fills (the figure assumes push + transmit interleave; the runtime
 * decoupled them into push-now / drain-later, losing the N(s) semantics). This
 * is M0LTE/packet.net#231; the fix mirrors `ActionDispatcher.EmitOldIFrame`
 * (PR M0LTE/packet.net#232). Retransmits also go out unconditionally — they are
 * already-counted frames being replayed, not new transmissions subject to the
 * send window. N(s) is the supplied original sequence; N(r) piggybacks the
 * current V(r); P=0 (the poll, when needed, is a separate enquiry). Silently
 * skips if the frame has been evicted from storage — matches linbpq/direwolf.
 */
function emitOldIFrame(tx: TransitionContext, ns: number): void {
  const ctx = tx.context;
  const entry = ctx.sentIFrames.get(ns);
  if (!entry) return;
  tx.sendFrame(
    iFrame({
      destination: ctx.remote,
      source: ctx.local,
      digipeaters: reversedTriggerPath(tx),
      nr: ctx.vr,
      ns,
      info: entry.data,
      pid: entry.pid,
      pollBit: false,
      extended: ctx.isExtended,
    }),
  );
}

function saveIncomingIFrame(tx: TransitionContext): void {
  if (!tx.event.frame) {
    throw new Error(
      "action 'save_contents_of_I_frame' requires a frame-receipt trigger.",
    );
  }
  const ns = getNs(tx.event.frame);
  const info = tx.event.frame.info;
  const pid = tx.event.frame.pid ?? 0xf0;
  tx.context.storedReceivedIFrames.set(ns, { info, pid });
}

// Implements `Retrieve Stored V(r) I Frame`: consume the stored frame at V(r)
// and *stage* it on tx for the following `DL-DATA Indication` to deliver. The
// figc4.4/4.5 drain loop draws retrieval and delivery as two separate actions,
// so staging (rather than delivering here) avoids the loop body double-
// delivering. No-op if nothing is stored at V(r).
function retrieveStoredVrIFrame(tx: TransitionContext): void {
  const ctx = tx.context;
  const stored = ctx.storedReceivedIFrames.get(ctx.vr);
  if (!stored) return;
  ctx.storedReceivedIFrames.delete(ctx.vr);
  tx.retrievedStoredFrame = stored;
}

function buildDataIndication(tx: TransitionContext): DataLinkSignal {
  // Inside the stored-frame drain loop, a preceding `Retrieve Stored V(r) I
  // Frame` stages the frame to deliver here; consume it. Outside the loop,
  // deliver the triggering frame.
  if (tx.retrievedStoredFrame != null) {
    const staged = tx.retrievedStoredFrame;
    tx.retrievedStoredFrame = null;
    return { type: "DL_DATA_indication", data: staged.info, pid: staged.pid };
  }
  if (!tx.event.frame) {
    throw new Error(
      "action 'DL_DATA_indication' requires the trigger to be a frame-receipt event.",
    );
  }
  const f = tx.event.frame;
  if (f.pid === null) {
    throw new Error(
      "action 'DL_DATA_indication' requires the incoming frame to carry a PID.",
    );
  }
  return { type: "DL_DATA_indication", data: f.info, pid: f.pid };
}

function buildUnitDataIndication(tx: TransitionContext): DataLinkSignal {
  if (!tx.event.frame) {
    throw new Error(
      "action 'DL-UNIT-DATA Indication' requires a frame-receipt trigger.",
    );
  }
  const f = tx.event.frame;
  return {
    type: "DL_UNIT_DATA_indication",
    data: f.info,
    pid: f.pid ?? 0xf0,
  };
}

function extractNr(tx: TransitionContext): number {
  if (!tx.event.frame) {
    throw new Error(
      "action requires an incoming frame, but the trigger " +
        `'${tx.event.name}' is not a frame-receipt event.`,
    );
  }
  return getNr(tx.event.frame);
}

function extractNs(tx: TransitionContext): number {
  if (!tx.event.frame) {
    throw new Error(
      "action requires an incoming frame, but the trigger " +
        `'${tx.event.name}' is not a frame-receipt event.`,
    );
  }
  return getNs(tx.event.frame);
}

function extractPollFinal(tx: TransitionContext): boolean {
  if (!tx.event.frame) {
    throw new Error(
      "action 'F := P' requires an incoming frame, but the trigger " +
        `'${tx.event.name}' is not a frame-receipt event.`,
    );
  }
  return framePollFinal(tx.event.frame);
}
