import type { ActionStep } from "ax25sdl";
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
 * Thrown when an action verb fired through the dispatcher isn't handled
 * by any case arm. The error message names the verb and the surrounding
 * state so transcription typos in `*.sdl.yaml` surface in tests.
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
 * The verb vocabulary is bounded by what the transcriptions emit. New
 * verbs land here as new pages land; an unrecognised verb throws
 * {@link UnknownActionError} so transcription typos don't silently
 * disappear. This is the same shape as the C# `ActionDispatcher`.
 *
 * Two reductions relative to the C# runtime:
 *
 *   1. figc4.7 subroutines route through a no-op registry — the
 *      dispatcher inlines the minimum subroutine behaviour the happy
 *      path needs (`Establish_Data_Link` synthesises SABM + start_T1;
 *      `Select_T1_Value` is a no-op; everything else is a logged stub).
 *      See README.
 *   2. Some verbs the figures emit (e.g. `set_version_2_2`, mod-128
 *      paths) work but have limited effect because the session driver
 *      doesn't honour mod-128 yet.
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

  constructor(
    _t1Ms: number,
    private readonly t2Ms: number,
    private readonly t3Ms: number,
    private readonly onTimerExpiry: (name: TimerName) => void,
  ) {
    // T1's duration is now sourced from ctx.t1vMs on every arm — the
    // initial value is set on the context by the driver. The argument
    // is kept for symmetry with the C# dispatcher's T1Duration property.
    void _t1Ms;
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
    verb: string,
    tx: TransitionContext,
    currentState: string,
  ): void {
    const ctx = tx.context;
    const sched = tx.scheduler;

    switch (verb) {
      // ─── Flag mutations ────────────────────────────────────────────
      case "set_own_receiver_busy":
      case "Set Own Receiver Busy":     ctx.ownReceiverBusy = true; return;
      case "clear_own_receiver_busy":   ctx.ownReceiverBusy = false; return;
      case "set_peer_receiver_busy":    ctx.peerReceiverBusy = true; return;
      case "clear_peer_receiver_busy":  ctx.peerReceiverBusy = false; return;
      case "set_acknowledge_pending":
      case "Set Acknowledge Pending":   ctx.acknowledgePending = true; return;
      case "clear_acknowledge_pending":
      case "Clear Acknowledge Pending": ctx.acknowledgePending = false; return;
      case "set_layer_3_initiated":
      case "Set Layer 3 Initiated":     ctx.layer3Initiated = true; return;
      case "clear_layer_3_initiated":
      case "Clear Layer 3 Initiated":   ctx.layer3Initiated = false; return;

      // ─── Timer ops ────────────────────────────────────────────────
      case "start_T1":
      case "Start T1":
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      case "start_T2":                  sched.arm("T2", this.t2Ms, () => this.onTimerExpiry("T2")); return;
      case "start_T3":
      case "Start T3":                  sched.arm("T3", this.t3Ms, () => this.onTimerExpiry("T3")); return;
      case "stop_T1":
      case "Stop T1":
        ctx.t1RemainingWhenLastStoppedMs = sched.timeRemainingMs("T1");
        sched.cancel("T1");
        return;
      case "stop_T2":                   sched.cancel("T2"); return;
      case "stop_T3":
      case "Stop T3":                   sched.cancel("T3"); return;

      // ─── Queue clears ─────────────────────────────────────────────
      case "discard_i_frame_queue":
      case "discard_frame_queue":
      case "discard_queue":
      case "discard_I_frame_queue":
      case "Discard I Queue Entries":
      case "Discard Queue":             ctx.iFrameQueue.length = 0; return;
      case "discard_I_frame":
      case "discard_contents_of_I_frame":
      case "discard_primitive":
      case "Discard I Frame":
      case "Discard Contents of I Frame":
      case "Discard Primitive":         return; // no-op — incoming not stored anywhere

      // ─── REJ / SREJ bookkeeping ───────────────────────────────────
      case "set_reject_exception":
      case "Set Reject Exception":      ctx.rejectException = true; return;
      case "clear_reject_exception":
      case "Clear Reject Condition":
      case "Clear Reject Exception":    ctx.rejectException = false; return;
      case "Clear Sreject Condition":
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        return;
      case "increment_srej_exception":
      case "Increment Sreject Exception":
      case "Sreject := Sreject + 1":
        ctx.srejExceptionCount++;
        ctx.selectiveRejectException = true;
        return;
      case "decrement_srej_exception_if_gt_0":
      case "Decrement Sreject Exception if > 0":
        if (ctx.srejExceptionCount > 0) {
          ctx.srejExceptionCount--;
          if (ctx.srejExceptionCount === 0) {
            ctx.selectiveRejectException = false;
          }
        }
        return;

      // ─── Receiver-busy clears (figc4.7 verbatim) ──────────────────
      case "Clear Peer Receiver Busy":  ctx.peerReceiverBusy = false; return;
      case "Clear Own Receiver Busy":   ctx.ownReceiverBusy  = false; return;

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
      case "set_version_2_0":           ctx.isExtended = false; return;
      case "set_version_2_2":
      case "Set Version 2.2":           ctx.isExtended = true;  return;
      case "Modulo <- 8":               ctx.isExtended = false; return;
      case "Modulo <- 128":             ctx.isExtended = true;  return;
      case "Set Half Duplex":           ctx.halfDuplex = true; return;
      case "Set Implicit Reject":
        ctx.implicitReject = true;
        ctx.srejEnabled = false;
        return;
      case "Set Selective Reject":
        ctx.implicitReject = false;
        ctx.srejEnabled = true;
        return;
      case "N1 <- 2048":                ctx.n1 = 2048; return;
      case "k <- 8":                    ctx.k = 8; return;
      case "k <- 32":                   ctx.k = 32; return;
      case "T2 <- 3000":                ctx.t2Ms = 3000; return;
      case "N2 <- 10":                  ctx.n2 = 10; return;

      // ─── Link-parameter assignments ───────────────────────────────
      // These can be suppressed via `freezeT1V` so a caller-supplied
      // t1Ms isn't overwritten by the spec's default-init actions.
      case "SRT := Initial Default":
        if (!this.freezeT1V) ctx.srtMs = 3000;
        return;
      case "T1V := 2 * SRT":
        if (!this.freezeT1V) ctx.t1vMs = ctx.srtMs * 2;
        return;
      case "Next T1 <- 2 * SRT":
        if (!this.freezeT1V) ctx.t1vMs = ctx.srtMs * 2;
        return;
      case "Next T1 <- (RC*0.25)+SRT*2":
        if (!this.freezeT1V) ctx.t1vMs = ctx.rc * 250 + ctx.srtMs * 2;
        ctx.t1HadExpired = false;
        return;
      case "SRT <- 7(SRT)/8 + (T1)/8 - (Remaining Time on T1 When Last Stopped)/8": {
        if (!this.freezeT1V) {
          let sample = ctx.t1vMs - ctx.t1RemainingWhenLastStoppedMs;
          if (sample < 0) sample = 0;
          ctx.srtMs = 0.875 * ctx.srtMs + 0.125 * sample;
        }
        ctx.t1HadExpired = false;
        ctx.t1RemainingWhenLastStoppedMs = 0;
        return;
      }

      // ─── Sequence-variable assignments ────────────────────────────
      case "V(s) := 0":                 ctx.vs = 0; return;
      case "V(s) := V(s) + 1":
      case "V(s) <- V(s) + 1":         ctx.vs = incrementSeq(ctx, ctx.vs); return;
      case "V(r) := 0":                 ctx.vr = 0; return;
      case "V(r) := V(r) + 1":          ctx.vr = incrementSeq(ctx, ctx.vr); return;
      // figc4.5 Timer Recovery draws the stored-frame drain with V(r) := V(r) - 1.
      // Surprising for a drain; flagged upstream for spec-author review
      // (ax25sdl#49). Encoded faithfully pending that.
      case "V(r) := V(r) - 1":          ctx.vr = decrementSeq(ctx, ctx.vr); return;
      case "V(a) := 0":                 ctx.va = 0; return;
      case "RC := 0":                   ctx.rc = 0; return;
      case "RC := 1":
      case "RC <- 1":                   ctx.rc = 1; return;
      case "RC := RC + 1":              ctx.rc++; return;
      case "V(a) := N(r)":
      case "V(a) <- N(r)":              ctx.va = extractNr(tx); return;
      case "V(s) <- N(r)":              ctx.vs = extractNr(tx); return;
      case "X <- V(s)":                 ctx.x = ctx.vs; return;
      case "Backtrack":                 return; // informational marker

      // ─── Pending-frame field assignments ──────────────────────────
      case "N(r) := V(r)":
      case "N(r) <- V(r)":
      case "N(R) := V(r)":             tx.pending.nr = ctx.vr; return;
      case "N(s) := V(s)":             tx.pending.ns = ctx.vs; return;
      case "N(r) := N(s)":             tx.pending.nr = extractNs(tx); return;
      case "F := 0":                   tx.pending.pfBit = false; return;
      case "F := 1":                   tx.pending.pfBit = true;  return;
      case "F := P":                   tx.pending.pfBit = extractPollFinal(tx); return;
      case "p := 0":
      case "P := 0":                   tx.pending.pfBit = false; return;
      case "P <- 1":                   tx.pending.pfBit = true; return;

      // ─── Supervisory-frame transmissions ──────────────────────────
      case "RR_command":
      case "RR Command":
      case "RR Command (P = 0)":
        tx.sendFrame(buildSFrame(tx, "RR", true)); return;
      case "RR":
      case "RR Response":
        tx.sendFrame(buildSFrame(tx, "RR", false)); return;
      case "RNR Command":
        tx.sendFrame(buildSFrame(tx, "RNR", true)); return;
      case "RNR_response":
      case "RNR Response":
      case "RNR Response (F = 0)":
      case "RNR":
        tx.sendFrame(buildSFrame(tx, "RNR", false)); return;
      case "REJ":
        tx.sendFrame(buildSFrame(tx, "REJ", false)); return;
      case "SREJ":
        // SREJ frame factory isn't in the public API yet — fall back to
        // REJ. Documented in README as a v1 reduction.
        tx.sendFrame(buildSFrame(tx, "REJ", false)); return;

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
        // Mod-128 not implemented; emit a SABM as a fallback (this path
        // is rarely hit in our happy paths since we always negotiate
        // mod-8 / version_2_0).
        tx.sendFrame(buildUFrame(tx, "SABM", true, true)); return;
      case "DISC (P = 1)":
        tx.sendFrame(buildUFrame(tx, "DISC", true, true)); return;

      // ─── UI / I-frame transmissions ───────────────────────────────
      case "UI_command":
      case "UI Command":
        tx.sendFrame(buildUiFrame(tx, true)); return;
      case "I_command":
      case "I Command":
        emitIFrame(tx); return;

      // ─── DL upper-layer signals ───────────────────────────────────
      case "DL_CONNECT_indication":
      case "DL Connect Indication":
      case "DL-CONNECT Indication":     tx.emitUpward({ type: "DL_CONNECT_indication" }); return;
      case "DL_CONNECT_confirm":
      case "DL-CONNECT Confirm":        tx.emitUpward({ type: "DL_CONNECT_confirm" }); return;
      case "DL_DISCONNECT_indication":
      case "DL-DISCONNECT Indication":
      case "DL-DISCONNECT indication":  tx.emitUpward({ type: "DL_DISCONNECT_indication" }); return;
      case "DL_DISCONNECT_confirm":
      case "DL-DISCONNECT Confirm":     tx.emitUpward({ type: "DL_DISCONNECT_confirm" }); return;
      case "DL_DATA_indication":
      case "DL-DATA Indication":        tx.emitUpward(buildDataIndication(tx)); return;
      case "DL-UNIT-DATA Indication":   tx.emitUpward(buildUnitDataIndication(tx)); return;
      case "DL_ERROR_indication_C_D":
      case "DL-ERROR Indication (C,D)": tx.emitUpward({ type: "DL_ERROR_indication", code: "C_D" }); return;
      case "DL_ERROR_indication_D":
      case "DL-ERROR Indication (D)":
      case "DL-ERROR indication (D)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "D" }); return;
      case "DL_ERROR_indication_E":
      case "DL-ERROR Indication (E)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "E" }); return;
      case "DL_ERROR_indication_F":
      case "DL-ERROR Indication (F)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "F" }); return;
      case "DL_ERROR_indication_G":
      case "DL-ERROR Indication (G)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "G" }); return;
      case "DL-ERROR Indication (I)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "I" }); return;
      case "DL_ERROR_indication_K":
      case "DL-ERROR Indication (K)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "K" }); return;
      case "DL_ERROR_indication_L":
      case "DL-ERROR Indication (L)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "L" }); return;
      case "DL_ERROR_indication_M":
      case "DL-ERROR Indication (M)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "M" }); return;
      case "DL_ERROR_indication_N":
      case "DL-ERROR Indication (N)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "N" }); return;
      case "DL_ERROR_indication_O":
      case "DL-ERROR Indication (O)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "O" }); return;
      case "DL-ERROR Indication (A)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "A" }); return;
      case "DL-ERROR Indication (J)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "J" }); return;
      case "DL-ERROR Indication (Q)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "Q" }); return;
      case "DL-ERROR Indication (T)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "T" }); return;
      case "DL-ERROR Indication (U)":   tx.emitUpward({ type: "DL_ERROR_indication", code: "U" }); return;
      case "DL-ERROR Indication (add)": tx.emitUpward({ type: "DL_ERROR_indication", code: "add" }); return;

      // ─── Link-multiplexer signals (no-op in this transport model) ─
      case "LM_seize_request":
      case "LM_release_request":
      case "LM_data_request":
      case "LM-SEIZE Request":
      case "LM-SIEZE Request":
      case "LM-RELEASE Request":
      case "LM_RELEASE Request":
      case "LM-DATA Request":           return;

      // ─── Internal-out signals ─────────────────────────────────────
      case "MDL_NEGOTIATE_request":
      case "MDL-NEGOTIATE Request":     return; // XID negotiation not implemented
      case "push_on_I_frame_queue":
      case "push_frame_on_queue":
      case "Push on I Frame Queue":
      case "Push on I Frame Queue (note: word order?)":
      case "Push I Frame on I Queue":
      case "Push Frame on Queue":       pushOnIFrameQueue(tx); return;
      case "push_old_I_frame_N_r_on_queue":
      case "Push Old I Frame N(r) on Queue":
                                        pushOldIFrameNrOnQueue(tx); return;
      case "Push Old I Frame onto Queue":
        // figc4.7 Invoke_Retransmission body — push the I-frame whose
        // N(S) == V(s) (Invoke_Retransmission has just backtracked V(s)
        // to N(r) and is iterating up to the original).
        {
          const stash = ctx.sentIFrames.get(ctx.vs);
          if (stash) {
            ctx.iFrameQueue.push({ data: stash.data, pid: stash.pid });
          }
        }
        return;

      // ─── Save / retrieve out-of-sequence I-frames ─────────────────
      case "save_contents_of_I_frame":
      case "Save Contents of I Frame":  saveIncomingIFrame(tx); return;
      case "retrieve_stored_V_r_I_frame":
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
        tx.sendFrame(buildUFrame(tx, "SABM", true, true));
        sched.cancel("T3");
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      case "Establish_Extended_Data_Link":
        // Same body as Establish_Data_Link for our purposes (mod-128
        // not honoured — we always send SABM mod-8).
        ctx.peerReceiverBusy = false;
        ctx.ownReceiverBusy = false;
        ctx.rejectException = false;
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        ctx.acknowledgePending = false;
        ctx.iFrameQueue.length = 0;
        ctx.rc = 1;
        tx.pending.pfBit = true;
        tx.sendFrame(buildUFrame(tx, "SABM", true, true));
        sched.cancel("T3");
        sched.arm("T1", ctx.t1vMs, () => this.onTimerExpiry("T1"));
        return;
      case "Clear_Exception_Conditions":
        ctx.peerReceiverBusy = false;
        ctx.ownReceiverBusy = false;
        ctx.rejectException = false;
        ctx.selectiveRejectException = false;
        ctx.srejExceptionCount = 0;
        ctx.acknowledgePending = false;
        ctx.iFrameQueue.length = 0;
        return;
      case "Select_T1_Value":
        // TODO: implement RTT smoothing (figc4.7 t01–t03). For now treat
        // as a no-op; T1V stays at its initial value. The happy paths
        // don't require dynamic tuning.
        return;
      case "UI_Check":
      case "UI Check":
        // TODO: figc4.7 UI_Check subroutine — surface incoming UI as
        // DL-UNIT-DATA. Out of scope until UI handling is wired top to
        // bottom.
        return;
      case "Check_I_Frame_Acknowledged":
      case "Check_I_Frames_Acknowledged":
      case "Check I Frame Acknowledged": {
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
      case "Check_Need_For_Response":
      case "Check Need For Response":
      case "Transmit_Enquiry":
      case "Transmit Enquiry":
      case "Transmit Enquery":
      case "Invoke_Retransmission":
      case "Invoke Retransmission":
      case "N_r_Error_Recovery":
      case "N(r) Error Recovery":
      case "N(r) Recovery":
      case "Enquiry_Response":
      case "Enquiry_Response_F_0":
      case "Enquiry Response (F = 0)":
      case "Enquiry_Response_F_1":
      case "Set_Version_2_0":
      case "Set_Version_2_2":
        // Route through the registry; default impl logs unknown and
        // continues. Production users can register handlers per-name.
        tx.subroutines.invoke(verb, tx);
        return;

      default:
        throw new UnknownActionError(verb, currentState);
    }
  }
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
  type: "RR" | "RNR" | "REJ",
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
  };
  if (type === "RR") return rr(opts);
  if (type === "RNR") return rnr(opts);
  return rej(opts);
}

function buildUFrame(
  tx: TransitionContext,
  type: "SABM" | "DISC" | "UA" | "DM",
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

function pushOldIFrameNrOnQueue(tx: TransitionContext): void {
  const ctx = tx.context;
  const nr = extractNr(tx);
  const entry = ctx.sentIFrames.get(nr);
  if (!entry) return;
  ctx.iFrameQueue.push({ data: entry.data, pid: entry.pid });
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
