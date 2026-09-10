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
/**
 * Every guard atom the data-link session is responsible for binding: the whole
 * closed set except `RC_eq_NM201`, which belongs to the MDL driver. Excluding
 * it by type rather than by convention is what lets the table below be checked
 * for completeness at compile time.
 */
type SessionBoundGuard = Exclude<Ax25Guard, "RC_eq_NM201">;

export function createSessionBindings(
  context: Ax25SessionContext,
  scheduler: TimerScheduler,
  currentTrigger: () => Ax25Event | null,
): GuardBindings {

  // ─── Flags (§C4.3) ──────────────────────────────────────────────────

  // ─── Node policy ─────────────────────────────────────────────────────
  // "Able to establish?" — defer to station policy; default reads
  // `acceptIncoming` from the session context (default true — matches
  // direwolf's "always willing to accept connections"). The
  // {@link Ax25Listener} flips this flag at the session boundary on a
  // transient session it has chosen to reject so the SDL t15 path
  // emits DM. Override the entry in the returned map before handing it
  // to GuardEvaluator if you need finer-grained acceptance control
  // (callsign allow-list, channel busy, resource limits).

  // ─── Sequence-variable comparisons (mod-aware) ──────────────────────

  // ─── Timer state ────────────────────────────────────────────────────

  // ─── Retry-counter comparison ──────────────────────────────────────

  // ─── Queue / storage state ─────────────────────────────────────────

  // ─── figc4.7 subroutine predicates ─────────────────────────────────
  // Invoke_Retransmission loop terminator: V(s) caught up to its
  // saved-on-entry value X. Returns false if X hasn't been set (i.e. we're not
  // inside an Invoke_Retransmission call).

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


  // `vr_lt_ns_lt_vr_plus_k` - is the out-of-sequence I frame's N(s) inside the
  // receive window this station granted? The figure draws the open interval
  // V(r) < N(s) < V(r)+k (packethacking/ax25spec#40, matching X.25 2.4.6.4(b)),
  // so an N(s) outside it is a duplicate of a frame already received and
  // acknowledged, and the No arm discards it. effectiveWindow, not context.k:
  // it carries the ax25spec#13 SREJ half-modulus clamp and is what we granted.

  // `va_le_nr_le_vs` — incoming N(R) lies in [V(a), V(s)] (inclusive in mod-N
  // arithmetic).

  // `info_field_length_le_N1_and_content_is_octet_aligned` — heuristic:
  // info-field present and within ctx.n1.

  // N(r) comparisons for Check_I_Frame_Acknowledged.
  // ax25sdl#53: the figc4.5 recovery-complete decision is drawn after
  // "V(a) := N(r)", so it tests V(s) == N(r); the table emits the
  // post-assignment guard vs_eq_nr — the same comparison as nr_eq_vs.

  // Compound flags for Check_Need_For_Response.

  // Enquiry_Response's compound: F=1 AND the triggering frame is an
  // RR / RNR / I (a poll-able shape). REJ/SREJ excluded per the figure.

  // The binding table is an object literal typed as a Record over the closed
  // set, NOT an incrementally-built Map. That is deliberate: a Map built by
  // .set() type-checks its keys but has no completeness check, so a new atom
  // arriving in the Ax25Guard union upstream compiles clean here and then
  // throws GuardEvaluationError the first time the new decision is reached -
  // on air, on a real link. As a Record it is a compile error instead, which
  // is the same gate C# gets from its exhaustive switch (CS8509) and Rust from
  // its catch-all-free match. Found the hard way: ax25spec#40 added
  // vr_lt_ns_lt_vr_plus_k and this leg was the only one of the three that
  // would have shipped the gap silently.
  //
  // RC_eq_NM201 is excluded by type: the MDL driver supplies it via
  // extraBindings, since it reads an NM201 the data-link session cannot see.
  const table: Record<SessionBoundGuard, () => boolean> = {
    "own_receiver_busy": () => context.ownReceiverBusy,
    "peer_receiver_busy": () => context.peerReceiverBusy,
    "ack_pending": () => context.acknowledgePending,
    "reject_exception": () => context.rejectException,
    "layer_3_initiated": () => context.layer3Initiated,
    "SREJ_enabled": () => context.srejEnabled,
    "version_2_2": () => context.isExtended,
    "sreject_exception_gt_0": () => context.srejExceptionCount > 0,
    "able_to_establish": () => context.acceptIncoming,
    "vs_eq_va": () => context.vs === context.va,
    "vs_eq_va_plus_k": () => {
      const m = ctxModulus(context);
      return ((context.vs - context.va + m) % m) >= effectiveWindow(context);
    },
    "T1_running": () => scheduler.isRunning("T1"),
    "RC_eq_N2": () => context.rc === context.n2,
    "RC_eq_0": () => context.rc === 0,
    "vr_I_frame_stored": () =>
      context.storedReceivedIFrames.has(context.vr),
    "mod_128": () => context.isExtended,
    "mod_8": () => !context.isExtended,
    "T1_expired": () => context.t1HadExpired,
    "out_of_sequence_frames_in_receive_buffer": () => context.storedReceivedIFrames.size > 0,
    "vs_eq_X": () => context.x !== null && context.vs === context.x,
    "P_eq_1": incomingPollFinal,
    "F_eq_1": incomingPollFinal,
    "P_or_F_eq_1": incomingPollFinal,
    "command": incomingCommand,
    "response": () => {
      const f = getFrame();
      return f !== null && frameIsResponse(f);
    },
    "ns_eq_vr": () => {
      const f = getFrame();
      if (f === null) return false;
      return getNs(f) === context.vr;
    },
    "ns_gt_vr_plus_1": () => {
      const f = getFrame();
      if (f === null) return false;
      const m = ctxModulus(context);
      const diff = (getNs(f) - context.vr + m) % m;
      return diff > 1;
    },
    "vr_lt_ns_lt_vr_plus_k": () => {
      const f = getFrame();
      if (f === null) return false;
      const m = ctxModulus(context);
      const offset = (getNs(f) - context.vr + m) % m;
      return offset > 0 && offset < effectiveWindow(context);
    },
    "va_le_nr_le_vs": () => {
      const f = getFrame();
      if (f === null) return false;
      const m = ctxModulus(context);
      const span = (context.vs - context.va + m) % m;
      const nrDelta = (getNr(f) - context.va + m) % m;
      return nrDelta <= span;
    },
    "info_field_length_le_N1_and_content_is_octet_aligned": () => {
      const f = getFrame();
      if (f === null) return false;
      return f.info.length <= context.n1;
    },
    "nr_eq_vs": () => {
      const f = getFrame();
      if (f === null) return false;
      return getNr(f) === context.vs;
    },
    "vs_eq_nr": () => {
      const f = getFrame();
      if (f === null) return false;
      return context.vs === getNr(f);
    },
    "nr_eq_va": () => {
      const f = getFrame();
      if (f === null) return false;
      return getNr(f) === context.va;
    },
    "command_and_P_eq_1": () => {
      const f = getFrame();
      return f !== null && frameIsCommand(f) && pollFinal(f);
    },
    "response_and_F_eq_1": () => {
      const f = getFrame();
      return f !== null && frameIsResponse(f) && pollFinal(f);
    },
    "F_eq_1_and_frame_eq_RR_or_frame_eq_RNR_or_frame_eq_I": () => {
      const f = getFrame();
      if (f === null || !pollFinal(f)) return false;
      const ctrl = f.control;
      const isI = (ctrl & 0x01) === 0;
      const sBase = ctrl & 0x0f;
      const isRR = sBase === 0x01;
      const isRNR = sBase === 0x05;
      return isI || isRR || isRNR;
    },
  };

  // Mutable here so the trigger-scoped quirk below can wrap an entry; the
  // return type widens it back to the ReadonlyMap callers see.
  const bindings = new Map<Ax25Guard, () => boolean>(
    Object.entries(table) as [Ax25Guard, () => boolean][],
  );

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
