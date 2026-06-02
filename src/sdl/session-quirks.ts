/**
 * Per-session toggles for deliberate, documented deviations from the AX.25
 * SDL figures, used where a figure is a confirmed upstream spec defect.
 *
 * This is the session-layer analogue of wire-parse pragmatism options: the
 * SDL tables themselves (`ax25sdl`, from `m0lte/ax25sdl`) stay faithful to
 * the published figures — including their defects — so the canonical
 * transcription tracks the in-progress draft. Where a figure is provably
 * wrong, the runtime corrects it here, behind a named flag, rather than
 * diverging the tables.
 *
 * Philosophy mirrors the C# `Ax25SessionQuirks` record (m0lte/packet.net):
 * the {@link defaultSessionQuirks} preset does the spec-*correct* thing so
 * the stack works out of the box; {@link strictlyFaithfulSessionQuirks}
 * turns every quirk off, reproducing the figures exactly as drawn (defects
 * and all) for strict conformance testing.
 *
 * **Pattern for adding a quirk** (replicable): name the flag
 * `ax25Spec<issue>…` after the `packethacking/ax25spec` issue it works
 * around — so it is greppable and removable once the spec is fixed —
 * default it to the corrected behaviour, document the spec prose + the
 * de-facto implementation evidence, and open a tracking issue to delete
 * it when `ax25sdl` ships a figure carrying the upstream resolution.
 */
export interface Ax25SessionQuirks {
  /**
   * Work around `packethacking/ax25spec#38`: figc4.5 (Timer Recovery)
   * draws the SREJ-received retransmit path as the generic fresh-DL-DATA
   * "Push frame onto queue" verb followed by "Invoke Retransmission"
   * (go-back-N). That contradicts §4.3.2.4 / §6.4.8 ("retransmission of
   * the *single* I frame numbered N(R) … frames transmitted following …
   * are not retransmitted"), figc4.4's correct SREJ handler, and every
   * surveyed implementation (direwolf and linbpq do single-frame
   * selective; linux and rax25 don't implement SREJ-driven go-back-N at
   * all). direwolf's author independently flagged the exact box as a
   * "2006 revision … cut-n-paste from the REJ flow chart" and disabled it.
   *
   * When `true` (default), an SREJ-received transition does single-frame
   * selective retransmit — it redirects the figure's "Push frame onto
   * queue" to the figc4.4 "Push Old I Frame N(r) on Queue" behaviour and
   * skips the go-back-N "Invoke Retransmission". When `false`, the
   * figc4.5 figure runs as drawn (which also throws on the payload-less
   * push — strict conformance only). Delete this quirk once `ax25sdl`
   * ships a corrected figc4.5.
   *
   * Mirrors `Ax25SessionQuirks.Ax25Spec38SrejSelectiveRetransmit` in
   * m0lte/packet.net (PR #228).
   */
  ax25Spec38SrejSelectiveRetransmit: boolean;

  /**
   * Work around `packethacking/ax25spec#40`: figc4.4's out-of-sequence
   * `I_received` handling has no receive-window guard. Any frame whose
   * N(S) ≠ V(R) is treated as a future gap and gets SREJ'd (or REJ'd) —
   * including a *duplicate* whose N(S) lies behind V(R), a frame the
   * receiver has already delivered. AX.25 inherits its sequencing from
   * ITU-T X.25 §2.4.6.4, which *discards* any I-frame whose N(S) falls
   * outside the receive window [V(R), V(R)+k) rather than rejecting it.
   * Without that guard a duplicate provokes an SREJ, the sender re-sends,
   * the re-send is again out-of-window, provokes another SREJ … a livelock
   * that never converges under multi-frame selective-reject recovery.
   *
   * When `true` (default), an I-frame whose N(S) is outside the receive
   * window is routed to figc4.4's own discard path (the
   * `reject_exception:Yes` branch — process the acknowledgement, discard
   * the data, respond RR(V(R)) only if P=1) instead of the SREJ/REJ path.
   * The window predicate is OR'd into the figure's `reject_exception`
   * decision — the exact point where the figure already chooses
   * discard-over-reject — so no new transition or per-action rewrite is
   * needed, and the fix covers both the SREJ and REJ out-of-sequence
   * branches (the decision precedes the `srej_enabled` split). When
   * `false`, the figure runs as drawn (out-of-window frames are SREJ'd,
   * reproducing the livelock for strict conformance study). Delete once
   * `ax25sdl` ships a figc4.4 carrying the upstream window guard.
   *
   * Mirrors `Ax25SessionQuirks.Ax25Spec40DiscardOutOfWindowIFrames` in
   * m0lte/packet.net (PR #242).
   */
  ax25Spec40DiscardOutOfWindowIFrames: boolean;

  /**
   * Work around `packethacking/ax25spec#41`: figc4.7 `Select_T1_Value`
   * folds `(T1V − "Remaining Time on T1 When Last Stopped")` into the
   * smoothed round-trip time without Karn's-algorithm guard. That term is
   * only a valid round-trip sample when T1 was stopped by an
   * acknowledgement of the frame whose transmission armed it. When the
   * frame timed out / was retransmitted (or T1 was otherwise not freshly
   * stopped by an ack), the remaining time is 0 and the "sample"
   * degenerates to the full T1V (= 2·SRT). Since T1V is derived from SRT,
   * feeding it back is self-amplifying: SRT' = 7/8·SRT + 1/8·(2·SRT) =
   * 1.125·SRT, so SRT (and T1V) grow geometrically under sustained loss
   * until `Next T1 <- 2*SRT` overflows.
   *
   * When `true` (default), the SRT IIR update is skipped unless a genuine
   * round-trip was measured this cycle — T1 was running and stopped by an
   * ack, i.e. `T1RemainingWhenLastStopped > 0`. On the timeout/retransmit
   * path SRT is left unchanged (T1V still backs off via the RC term), per
   * Karn. When `false`, the figure runs as drawn (the divergent IIR, for
   * strict conformance study — will overflow under sustained loss). Delete
   * once `ax25sdl` ships a figc4.7 carrying the Karn guard.
   *
   * Mirrors `Ax25SessionQuirks.Ax25Spec41KarnSrtSampling` in
   * m0lte/packet.net (PR #241).
   */
  ax25Spec41KarnSrtSampling: boolean;

  /**
   * Work around `packethacking/ax25spec#42`: figc4.4's out-of-sequence
   * `I_received` SREJ path, when a selective-reject exception is already
   * outstanding, does `N(r) := N(s)` before sending SREJ — so it requests
   * retransmission of the frame that just *arrived* (and was just saved),
   * not the missing gap. With more than one frame outstanding the real gap
   * is never re-requested: the peer keeps resending the already-received
   * frame and the receiver keeps SREJ'ing it, so selective-reject recovery
   * livelocks (V(R) frozen until T1/N2 intervene). direwolf flags the
   * identical erratum (`ax25_link.c`: "The SDL says ask for N(S) which is
   * clearly wrong because that's what we just received") and requests the
   * missing gap instead.
   *
   * When `true` (default), the SREJ target is retargeted from N(S) to V(R)
   * — the next still-missing frame — so the SREJ requests the actual gap.
   * The rewrite fires only on an `I_received` trigger (the sole figure path
   * carrying the `N(r) := N(s)` verb), so it is inert elsewhere. When
   * `false`, the figure runs as drawn (SREJ asks for the just-arrived
   * frame, reproducing the livelock for strict conformance study). Delete
   * once `ax25sdl` ships a figc4.4 requesting the gap.
   *
   * Mirrors `Ax25SessionQuirks.Ax25Spec42SrejTargetsGap` in
   * m0lte/packet.net (PR #246).
   */
  ax25Spec42SrejTargetsGap: boolean;
}

/**
 * Default preset — spec-*correct* behaviour (all quirks on). This is what
 * a session uses unless explicitly configured otherwise. Mirrors
 * `Ax25SessionQuirks.Default` in m0lte/packet.net.
 */
export const defaultSessionQuirks: Ax25SessionQuirks = {
  ax25Spec38SrejSelectiveRetransmit: true,
  ax25Spec40DiscardOutOfWindowIFrames: true,
  ax25Spec41KarnSrtSampling: true,
  ax25Spec42SrejTargetsGap: true,
};

/**
 * Every quirk off — execute the SDL figures exactly as drawn, including
 * known defects. For strict conformance testing against the published
 * figures, not for on-air use. Mirrors `Ax25SessionQuirks.StrictlyFaithful`
 * in m0lte/packet.net.
 */
export const strictlyFaithfulSessionQuirks: Ax25SessionQuirks = {
  ax25Spec38SrejSelectiveRetransmit: false,
  ax25Spec40DiscardOutOfWindowIFrames: false,
  ax25Spec41KarnSrtSampling: false,
  ax25Spec42SrejTargetsGap: false,
};
