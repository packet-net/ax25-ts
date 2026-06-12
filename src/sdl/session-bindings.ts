import type { Ax25Guard } from "ax25sdl";
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
  effectiveWindow,
} from "./session-context.js";
import type { TimerScheduler } from "./timer-scheduler.js";

/**
 * Build the standard binding table for an AX.25 session — every guard atom the
 * SDL transcriptions reference, mapped to a closure over the supplied context
 * and scheduler. The map is keyed by the generated {@link Ax25Guard} closed set
 * (from `ax25sdl`), so the table is exhaustive against the typed atoms and a
 * renamed / typo'd atom is a compile error rather than a runtime unbound-name
 * throw. This replaces the former string-keyed table that hand-mirrored
 * packet.net's `GuardEvaluator.PredicateAliases` to reconcile the figure /
 * historic spellings — the typed `Ax25Guard` already carries the canonical
 * spelling, so there are no dual-spelling entries to maintain.
 *
 * Mirrors the C# `Ax25SessionBindings.CreateDefault`. The vocabulary grows as
 * new transcriptions land; new atoms join the `Ax25Guard` union upstream
 * (`ax25sdl`) and get a binding here — and {@link GuardEvaluator} throws on an
 * unbound atom so a gap surfaces fast.
 *
 * The `currentTrigger` thunk returns the event currently being dispatched,
 * which frame-aware predicates dereference for `P_eq_1`, `command`,
 * `ns_eq_vr`, etc. When the trigger isn't a frame event, those predicates
 * fall back to safe defaults (`false` for P/F/command, out-of-window for
 * sequence checks).
 *
 * The `RC_eq_NM201` atom (figc5.2 management retry-limit diamond) is bound by
 * the MDL driver via its `extraBindings`, not here — it reads the MDL context's
 * NM201, which the data-link session has no view of.
 */
export function createSessionBindings(
  context: Ax25SessionContext,
  scheduler: TimerScheduler,
  currentTrigger: () => Ax25Event | null,
): GuardBindings {
  const bindings = new Map<Ax25Guard, () => boolean>();

  // ─── Flags (§C4.3) ──────────────────────────────────────────────────
  bindings.set("own_receiver_busy", () => context.ownReceiverBusy);
  bindings.set("peer_receiver_busy", () => context.peerReceiverBusy);
  bindings.set("ack_pending", () => context.acknowledgePending);
  bindings.set("reject_exception", () => context.rejectException);
  bindings.set("layer_3_initiated", () => context.layer3Initiated);
  bindings.set("SREJ_enabled", () => context.srejEnabled);
  bindings.set("version_2_2", () => context.isExtended);
  bindings.set("sreject_exception_gt_0", () => context.srejExceptionCount > 0);

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
  bindings.set("vs_eq_va", () => context.vs === context.va);
  bindings.set("vs_eq_va_plus_k", () => {
    const m = ctxModulus(context);
    return ((context.vs - context.va + m) % m) >= effectiveWindow(context);
  });

  // ─── Timer state ────────────────────────────────────────────────────
  bindings.set("T1_running", () => scheduler.isRunning("T1"));

  // ─── Retry-counter comparison ──────────────────────────────────────
  bindings.set("RC_eq_N2", () => context.rc === context.n2);
  bindings.set("RC_eq_0", () => context.rc === 0);

  // ─── Queue / storage state ─────────────────────────────────────────
  bindings.set("vr_I_frame_stored", () =>
    context.storedReceivedIFrames.has(context.vr),
  );

  // ─── figc4.7 subroutine predicates ─────────────────────────────────
  bindings.set("mod_128", () => context.isExtended);
  bindings.set("mod_8", () => !context.isExtended);
  bindings.set("T1_expired", () => context.t1HadExpired);
  bindings.set(
    "out_of_sequence_frames_in_receive_buffer",
    () => context.storedReceivedIFrames.size > 0,
  );
  // Invoke_Retransmission loop terminator: V(s) caught up to its
  // saved-on-entry value X. Returns false if X hasn't been set (i.e. we're not
  // inside an Invoke_Retransmission call).
  bindings.set(
    "vs_eq_X",
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

  bindings.set("ns_eq_vr", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNs(f) === context.vr;
  });
  bindings.set("ns_gt_vr_plus_1", () => {
    const f = getFrame();
    if (f === null) return false;
    const m = ctxModulus(context);
    const diff = (getNs(f) - context.vr + m) % m;
    return diff > 1;
  });

  // `va_le_nr_le_vs` — incoming N(R) lies in [V(a), V(s)] (inclusive in mod-N
  // arithmetic).
  bindings.set("va_le_nr_le_vs", () => {
    const f = getFrame();
    if (f === null) return false;
    const m = ctxModulus(context);
    const span = (context.vs - context.va + m) % m;
    const nrDelta = (getNr(f) - context.va + m) % m;
    return nrDelta <= span;
  });

  // `info_field_length_le_N1_and_content_is_octet_aligned` — heuristic:
  // info-field present and within ctx.n1.
  bindings.set("info_field_length_le_N1_and_content_is_octet_aligned", () => {
    const f = getFrame();
    if (f === null) return false;
    return f.info.length <= context.n1;
  });

  // N(r) comparisons for Check_I_Frame_Acknowledged.
  bindings.set("nr_eq_vs", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNr(f) === context.vs;
  });
  // ax25sdl#53: the figc4.5 recovery-complete decision is drawn after
  // "V(a) := N(r)", so it tests V(s) == N(r); the table emits the
  // post-assignment guard vs_eq_nr — the same comparison as nr_eq_vs.
  bindings.set("vs_eq_nr", () => {
    const f = getFrame();
    if (f === null) return false;
    return context.vs === getNr(f);
  });
  bindings.set("nr_eq_va", () => {
    const f = getFrame();
    if (f === null) return false;
    return getNr(f) === context.va;
  });

  // Compound flags for Check_Need_For_Response.
  bindings.set("command_and_P_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsCommand(f) && pollFinal(f);
  });
  bindings.set("response_and_F_eq_1", () => {
    const f = getFrame();
    return f !== null && frameIsResponse(f) && pollFinal(f);
  });

  // Enquiry_Response's compound: F=1 AND the triggering frame is an
  // RR / RNR / I (a poll-able shape). REJ/SREJ excluded per the figure.
  bindings.set("F_eq_1_and_frame_eq_RR_or_frame_eq_RNR_or_frame_eq_I", () => {
    const f = getFrame();
    if (f === null || !pollFinal(f)) return false;
    const ctrl = f.control;
    const isI = (ctrl & 0x01) === 0;
    const sBase = ctrl & 0x0f;
    const isRR = sBase === 0x01;
    const isRNR = sBase === 0x05;
    return isI || isRR || isRNR;
  });

  // ─── ax25spec#40 receive-window discard guard ──────────────────────
  // figc4.4's out-of-sequence I_received path has no window guard: any
  // N(S) ≠ V(R) is SREJ'd/REJ'd, including a duplicate behind V(R) — which
  // provokes a re-send that's again out-of-window, ad infinitum (the SREJ
  // livelock). X.25 §2.4.6.4 discards any frame whose N(S) is outside the
  // receive window [V(r), V(r)+k). The figure's `reject_exception` decision
  // IS its discard-vs-reject switch in that region, so we OR the
  // out-of-window condition into it (when ax25Spec40DiscardOutOfWindowIFrames
  // is on): such a frame takes the figure's own discard path (process ack,
  // discard data, RR(V(r)) only if P=1) ahead of the srej_enabled split,
  // covering both REJ and SREJ modes. Scoped to the I_received trigger via the
  // helper, so it's inert on every other trigger. See Ax25SessionQuirks.
  // Mirrors the ax25spec#40 block in Ax25SessionBindings.cs (PR #242).
  if (context.quirks.ax25Spec40DiscardOutOfWindowIFrames) {
    const iFrameOutOfWindow = (): boolean => {
      const trigger = currentTrigger();
      if (trigger === null || trigger.name !== "I_received") return false;
      const f = trigger.frame;
      if (f == null) return false;
      const m = ctxModulus(context);
      const offset = (getNs(f) - context.vr + m) % m;
      return offset >= effectiveWindow(context); // N(S) outside [V(r), V(r)+effective k)
    };
    const baseRejectException = bindings.get("reject_exception")!;
    bindings.set(
      "reject_exception",
      () => baseRejectException() || iFrameOutOfWindow(),
    );
  }

  // ax25spec#43: figc4.4 gates DL-FLOW-OFF's Set-Own-Receiver-Busy/RNR actions on
  // the own_receiver_busy=Yes branch, so a not-busy station receiving DL-FLOW-OFF
  // never enters busy — the primitive can't do its one job (§6.4.10; the FLOW-ON
  // mirror correctly acts on its Yes/busy branch). Invert the own_receiver_busy
  // guard for the DL_FLOW_OFF_request trigger only, so not-busy takes the action
  // branch and already-busy no-ops. Trigger-scoped: only the FLOW-OFF decision
  // reads own_receiver_busy during that dispatch, so it's inert elsewhere. Mirrors
  // the ax25spec#43 block in Ax25SessionBindings.cs (m0lte/packet.net).
  if (context.quirks.ax25Spec43DlFlowOffEntersBusy) {
    const baseOwnReceiverBusy = bindings.get("own_receiver_busy")!;
    bindings.set("own_receiver_busy", () =>
      currentTrigger()?.name === "DL_FLOW_OFF_request"
        ? !baseOwnReceiverBusy()
        : baseOwnReceiverBusy(),
    );
  }

  return bindings;
}
