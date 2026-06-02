import {
  type Ax25Frame,
  getNr,
  getNs,
  isCommand as frameIsCommand,
  isResponse as frameIsResponse,
  pollFinal,
} from "../frame.js";
import type { Ax25Event } from "./events.js";
import type { GuardBindings } from "./guard-evaluator.js";
import {
  type Ax25SessionContext,
  modulus as ctxModulus,
} from "./session-context.js";
import type { TimerScheduler } from "./timer-scheduler.js";

/**
 * Build the standard binding table for an AX.25 session — every identifier
 * the SDL transcriptions reference, mapped to a closure over the supplied
 * context and scheduler.
 *
 * Mirrors the C# `Ax25SessionBindings.CreateDefault`. The vocabulary grows
 * as new transcriptions land; new identifiers go here and {@link GuardEvaluator}
 * throws on unbound names so typos surface fast.
 *
 * The `currentTrigger` thunk returns the event currently being dispatched,
 * which frame-aware predicates dereference for `P_eq_1`, `command`,
 * `N_s_eq_V_r`, etc. When the trigger isn't a frame event, those predicates
 * fall back to safe defaults (`false` for P/F/command, out-of-window for
 * sequence checks).
 */
export function createSessionBindings(
  context: Ax25SessionContext,
  scheduler: TimerScheduler,
  currentTrigger: () => Ax25Event | null,
): GuardBindings {
  const bindings = new Map<string, () => boolean>();

  // ─── Flags (§C4.3) ──────────────────────────────────────────────────
  bindings.set("own_receiver_busy", () => context.ownReceiverBusy);
  bindings.set("peer_receiver_busy", () => context.peerReceiverBusy);
  bindings.set("acknowledge_pending", () => context.acknowledgePending);
  bindings.set("reject_exception", () => context.rejectException);
  bindings.set(
    "selective_reject_exception",
    () => context.selectiveRejectException,
  );
  bindings.set("layer_3_initiated", () => context.layer3Initiated);
  bindings.set("srej_enabled", () => context.srejEnabled);
  bindings.set("SREJ_enabled", () => context.srejEnabled);
  bindings.set("version_2_2", () => context.isExtended);
  bindings.set("srej_exception_gt_0", () => context.srejExceptionCount > 0);
  bindings.set("sreject_exception_gt_0", () => context.srejExceptionCount > 0);
  bindings.set("ACK_pending", () => context.acknowledgePending);
  bindings.set("ack_pending", () => context.acknowledgePending);
  bindings.set("own_receive_busy", () => context.ownReceiverBusy);
  bindings.set("peer_busy", () => context.peerReceiverBusy);

  // ─── Node policy ─────────────────────────────────────────────────────
  // "Able to establish?" — defer to station policy; default reads
  // `acceptIncoming` from the session context (default true — matches
  // direwolf's "always willing to accept connections"). The
  // {@link Ax25Listener} flips this flag at the session boundary on a
  // transient session it has chosen to reject so the SDL t15 path
  // emits DM. Override the entry in the returned map before handing it
  // to GuardEvaluator if you need finer-grained acceptance control
  // (callsign allow-list, channel busy, resource limits).
  bindings.set("able_to_establish", () => context.acceptIncoming);

  // ─── Sequence-variable comparisons (mod-aware) ──────────────────────
  bindings.set("V_s_eq_V_a", () => context.vs === context.va);
  bindings.set("vs_eq_va", () => context.vs === context.va);
  bindings.set("V_s_eq_V_a_plus_k", () => {
    const m = ctxModulus(context);
    return ((context.vs - context.va + m) % m) >= context.k;
  });
  bindings.set("vs_eq_va_plus_k", () => {
    const m = ctxModulus(context);
    return ((context.vs - context.va + m) % m) >= context.k;
  });

  // ─── Timer state ────────────────────────────────────────────────────
  bindings.set("T1_running", () => scheduler.isRunning("T1"));
  bindings.set("T2_running", () => scheduler.isRunning("T2"));
  bindings.set("T3_running", () => scheduler.isRunning("T3"));
  bindings.set("t1_running", () => scheduler.isRunning("T1"));

  // ─── Retry-counter comparison ──────────────────────────────────────
  bindings.set("RC_eq_N2", () => context.rc === context.n2);
  bindings.set("rc_eq_0", () => context.rc === 0);

  // ─── Queue / storage state ─────────────────────────────────────────
  bindings.set("V_r_I_frame_stored", () =>
    context.storedReceivedIFrames.has(context.vr),
  );
  bindings.set("vr_i_frame_stored", () =>
    context.storedReceivedIFrames.has(context.vr),
  );
  // Spelling the codegen actually emits for the figc4.4/4.5 stored-frame
  // drain loop predicate (capital spec-variable I, lower-case vr).
  bindings.set("vr_I_frame_stored", () =>
    context.storedReceivedIFrames.has(context.vr),
  );

  // ─── figc4.7 subroutine predicates ─────────────────────────────────
  bindings.set("mod_128", () => context.isExtended);
  bindings.set("mod_8", () => !context.isExtended);
  bindings.set("t1_expired", () => context.t1HadExpired);
  bindings.set(
    "out_of_sequence_frames_in_receive_buffer",
    () => context.storedReceivedIFrames.size > 0,
  );
  bindings.set(
    "v_s_eq_x",
    () => context.x !== null && context.vs === context.x,
  );

  // ─── Frame-aware predicates ─────────────────────────────────────────
  // These all read off the current trigger's attached frame. When the
  // trigger isn't a frame-receipt event (timer expiries, upper-layer
  // primitives), they return safe defaults — matches the figures'
  // expectation that frame-aware predicates only fire on frame-arrival
  // transitions.
  const getFrame = (): Ax25Frame | null => currentTrigger()?.frame ?? null;

  const incomingPollFinal = (): boolean => {
    const f = getFrame();
    return f !== null && pollFinal(f);
  };
  const incomingCommand = (): boolean => {
    const f = getFrame();
    return f !== null && frameIsCommand(f);
  };

  bindings.set("P_eq_1", incomingPollFinal);
  bindings.set("F_eq_1", incomingPollFinal);
  bindings.set("P_or_F_eq_1", incomingPollFinal);
  bindings.set("command", incomingCommand);
  bindings.set("response", () => {
    const f = getFrame();
    return f !== null && frameIsResponse(f);
  });

  bindings.set("N_s_eq_V_r", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNs(f) === context.vr;
  });
  bindings.set("ns_eq_vr", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNs(f) === context.vr;
  });
  bindings.set("N_s_gt_V_r_plus_1", () => {
    const f = getFrame();
    if (f === null) return false;
    const m = ctxModulus(context);
    const diff = (getNs(f) - context.vr + m) % m;
    return diff > 1;
  });
  bindings.set("ns_gt_vr_plus_1", () => {
    const f = getFrame();
    if (f === null) return false;
    const m = ctxModulus(context);
    const diff = (getNs(f) - context.vr + m) % m;
    return diff > 1;
  });

  // `nr_in_window` / `V_a_le_N_r_le_V_s` — same check: incoming N(R)
  // lies in [V(a), V(s)] (inclusive in mod-N arithmetic).
  const nrInWindow = (): boolean => {
    const f = getFrame();
    if (f === null) return false;
    const m = ctxModulus(context);
    const span = (context.vs - context.va + m) % m;
    const nrDelta = (getNr(f) - context.va + m) % m;
    return nrDelta <= span;
  };
  bindings.set("nr_in_window", nrInWindow);
  bindings.set("V_a_le_N_r_le_V_s", nrInWindow);
  bindings.set("va_le_nr_le_vs", nrInWindow);

  // `info_field_valid` — heuristic: info-field present and within ctx.n1.
  bindings.set("info_field_valid", () => {
    const f = getFrame();
    if (f === null) return false;
    return f.info.length <= context.n1;
  });
  bindings.set("info_field_length_le_N1_and_content_is_octet_aligned", () => {
    const f = getFrame();
    if (f === null) return false;
    return f.info.length <= context.n1;
  });

  // ─── figc4.7 frame-aware aliases ────────────────────────────────────
  bindings.set("incoming_is_command", incomingCommand);
  bindings.set("ui_info_field_valid", () => {
    const f = getFrame();
    if (f === null) return false;
    return f.info.length <= context.n1;
  });

  // N(r) comparisons for Check_I_Frame_Acknowledged.
  bindings.set("n_r_eq_v_s", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNr(f) === context.vs;
  });
  // ax25sdl#53: the figc4.5 recovery-complete decision is drawn after
  // "V(a) := N(r)", so it tests V(s) == N(r); the table emits the
  // post-assignment guard vs_eq_nr — the same comparison as n_r_eq_v_s.
  bindings.set("vs_eq_nr", () => {
    const f = getFrame();
    if (f === null) return false;
    return context.vs === getNr(f);
  });
  bindings.set("n_r_eq_v_a", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNr(f) === context.va;
  });

  // Compound flags for Check_Need_For_Response.
  bindings.set("command_and_p_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsCommand(f) && pollFinal(f);
  });
  bindings.set("command_and_P_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsCommand(f) && pollFinal(f);
  });
  bindings.set("response_and_f_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsResponse(f) && pollFinal(f);
  });
  bindings.set("response_and_F_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsResponse(f) && pollFinal(f);
  });

  // Enquiry_Response's compound: F=1 AND the triggering frame is an
  // RR / RNR / I (a poll-able shape). REJ/SREJ excluded per the figure.
  const fEq1AndSupervisoryOrI = (): boolean => {
    const f = getFrame();
    if (f === null || !pollFinal(f)) return false;
    const ctrl = f.control;
    const isI = (ctrl & 0x01) === 0;
    const sBase = ctrl & 0x0f;
    const isRR = sBase === 0x01;
    const isRNR = sBase === 0x05;
    return isI || isRR || isRNR;
  };
  bindings.set("f_eq_1_and_supervisory_or_i", fEq1AndSupervisoryOrI);
  // The figc4.7 Enquiry_Response paths reference this predicate under its
  // figure-verbatim name. ax25-ts's GuardEvaluator has no alias layer (unlike
  // packet.net's PredicateAliases), so bind the verbatim spelling directly —
  // otherwise every Enquiry_Response path is "unbound" and the walker skips
  // them all, so the delayed-ack RR never flushes (ax25-ts#12).
  bindings.set(
    "F_eq_1_and_frame_eq_RR_or_frame_eq_RNR_or_frame_eq_I",
    fEq1AndSupervisoryOrI,
  );

  return bindings;
}
