/**
 * Per-session toggles for deliberate, documented deviations from the AX.25
 * SDL figures, used where a figure is a confirmed upstream spec defect — and,
 * distinctly, where the published *wire format* is under-specified and we match
 * the only known interoperating implementation by default (see
 * {@link Ax25SessionQuirks.segmentFirstCarriesL3Pid}).
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
 * **Two flavours of quirk live here.**
 *
 * (1) **Figure-defect quirks** — name the flag `ax25Spec<issue>…` after the
 * `packethacking/ax25spec` issue it works around (so it is greppable and
 * removable once the spec is fixed), default it to the corrected behaviour,
 * document the spec prose + the de-facto implementation evidence, and open a
 * tracking issue to delete it when `ax25sdl` ships a figure carrying the
 * upstream resolution.
 *
 * (2) **De-facto-interop quirks** — where the spec text is genuinely ambiguous
 * or silent and a single real implementation establishes the de-facto wire
 * format. These are *not* tied to a filed figure-defect issue, so they do
 * **not** take the `ax25Spec<NN>` prefix; name them descriptively after what
 * they do (e.g. {@link Ax25SessionQuirks.segmentFirstCarriesL3Pid}). Default
 * them on (interoperate out of the box) and turn them off under
 * {@link strictlyFaithfulSessionQuirks} (reproduce the figure-literal reading).
 */
export interface Ax25SessionQuirks {
  /**
   * **De-facto-interop quirk (not a figure-defect — no ax25spec issue).**
   * Controls the §6.6 segmentation wire format. AX.25 v2.2 Figure 6.2 draws a
   * segmented I-frame's info field as the 0x08 segmented-PID octet plus a
   * single `FXXXXXXX` F/X octet (First-indicator + 7-bit remaining-count)
   * followed directly by the segment data — there is **no field carrying the
   * original Layer-3 PID** through a segmented series, so a figure-literal
   * reassembly has no way to recover it and must deliver the payload as
   * `PID_NO_LAYER_3` (0xF0). The §6.6 prose ("a two-octet header") is
   * ambiguous enough to admit a second reading, and **Dire Wolf (WB2OSZ) — the
   * only known v2.2 segmenter — takes it**: its *first* segment carries an
   * extra **inner-PID octet** (the original L3 PID) between the F/X octet and
   * the data, which its reassembler reads back so the reassembled payload keeps
   * its original PID (verified byte-exact against `ax25_link.c`
   * `dl_data_request` ~L1330–1410 + `dl_data_indication` ~L2010–2030, and on
   * the wire via packet.net's #177 docker stack).
   *
   * When `true` (default), the runtime emits and expects Dire Wolf's format:
   * the first segment's info field is
   * `[F/X octet][inner-PID = original L3 PID][segment data…]` and subsequent
   * segments are `[F/X octet][segment data…]`; the reassembler reads the inner
   * PID off the first segment and delivers the reassembled payload with that
   * **original L3 PID**. The inner-PID octet counts toward the segment budget —
   * it occupies one of the first segment's N1−1 payload slots, leaving N1−2 for
   * data (Dire Wolf's `DIVROUNDUP(len + 1, N1 − 1)` "+1 for the original PID").
   * This interoperates with Dire Wolf out of the box *and* fixes the
   * figure-literal limitation that the L3 PID is lost across a segmented series.
   *
   * When `false` ({@link strictlyFaithfulSessionQuirks}), the runtime emits and
   * expects the figure-literal format: every segment is
   * `[F/X octet][segment data…]` with no inner-PID octet, and a reassembled
   * payload is delivered as `PID_NO_LAYER_3` (0xF0) — Figure 6.2 exactly as
   * drawn, for strict conformance study.
   *
   * This is a wire-format de-facto-interop quirk, **not** a figc figure defect:
   * there is no filed `ax25spec` issue and it does not take the `ax25Spec<NN>`
   * prefix. The underlying spec gap (Figure 6.2 / §6.6's two-octet header drops
   * the L3 PID; Dire Wolf fills it non-standardly) is a candidate `ax25spec`
   * clarification. Mirrors `Ax25SessionQuirks.SegmentFirstCarriesL3Pid` in
   * m0lte/packet.net (PR #279).
   */
  segmentFirstCarriesL3Pid: boolean;

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

  /**
   * Work around `packethacking/ax25spec#43`: figc4.4 gates DL-FLOW-OFF's
   * Set-Own-Receiver-Busy/RNR actions on the `Own Receiver Busy? = Yes`
   * branch, so a *not-busy* station receiving DL-FLOW-OFF never enters busy —
   * the primitive can't establish flow control from a clean state. §6.4.10
   * (entering a busy condition → RNR) and the correct FLOW-ON mirror put the
   * actions on the `No` (not-busy) branch. When `true` (default), the
   * `own_receiver_busy` guard is inverted for the `DL_FLOW_OFF_request`
   * trigger only (inert elsewhere). No de-facto corroboration (neither
   * direwolf nor linbpq implements DL-FLOW-OFF); rests on the §6.4.10 prose +
   * the figure contradicting its own primitive. Mirrors
   * `Ax25SessionQuirks.Ax25Spec43DlFlowOffEntersBusy` in m0lte/packet.net ←
   * packethacking/ax25spec#43.
   */
  ax25Spec43DlFlowOffEntersBusy: boolean;

  /**
   * Work around `packethacking/ax25spec#44`: figc4.1/figc4.2 route the
   * `Disconnected` `DL-CONNECT request` path *unconditionally* to
   * `AwaitingConnection` — `Establish Data Link` → `Set Layer 3 Initiated` →
   * Awaiting Connection — with **no version branch**, regardless of modulo.
   * (Verified against the authoritative graphml `DataLink_Disconnected.graphml`
   * in `m0lte/ax25sdl`: the initiator's DL-CONNECT edge has no modulo test;
   * version routing exists only on the *responder* SABM/SABME-received side.)
   * That is a faithful transcription of a defective figure: a v2.2-preferred
   * connect sends a SABME (the figc4.7 `Establish_Data_Link` subroutine — inlined
   * in the TS dispatcher — *does* branch on `mod_128`/`isExtended` and emits
   * SABME), but then parks in `AwaitingConnection` (figc4.2) instead of
   * `AwaitingV22Connection` (figc4.6).
   *
   * Two real bugs follow from the mis-routing — both fixed by this redirect:
   * (1) `AwaitingConnection`'s T1-expiry retry sends a hardcoded `SABM (P==1)`
   * (figc4.2 `t05_t1_expiry_no` → `SABMPEqEq1`), so a lost initial SABME
   * *downgrades the link to mod-8* on the first retry; and (2)
   * `AwaitingConnection` has *no `FRMR_received` handler at all*, so the §975
   * fallback (a pre-v2.2 peer FRMRs our SABME → drop to v2.0/SABM) cannot fire.
   * `AwaitingV22Connection` (figc4.6) handles both correctly: `t13_t1_expiry_no`
   * resends `SABME (P=1)`; `t14_frmr_received` sets version 2.0, re-establishes,
   * and moves to `AwaitingConnection`; `t11_dm_received_yes` tears down (§975 DM
   * case); `t12_ua_received_*` completes the mod-128 connection.
   *
   * When `true` (default), a `DL_CONNECT_request` firing in `Disconnected` while
   * the link is extended (`ctx.isExtended`) has its transition target rewritten
   * from `AwaitingConnection` to `AwaitingV22Connection`; a mod-8 connect
   * (`isExtended === false`) is unchanged. Keying on `isExtended` at dispatch
   * time is self-consistent with the FRMR fallback: figc4.6 `t14` sets version
   * 2.0 (`isExtended = false`) before re-establishing, so the subsequent SABM
   * connect naturally stays mod-8. When `false`, the figure runs as drawn (a
   * mod-128 connect parks in `AwaitingConnection` and downgrades on retry — for
   * strict conformance study). Unlike the guard-rewriting quirks this rewrites a
   * transition's *target state* (in {@link SdlSessionDriver}'s dispatch path,
   * `resolveNextState`), scoped to the single `Disconnected` DL-CONNECT
   * transition under `isExtended`. De-facto corroboration: direwolf's author hit
   * the identical defect — `ax25_link.c` ~L1060 `enter_new_state(S, S->modulo ==
   * 128 ? state_5_awaiting_v22_connection : state_1_awaiting_connection)` with
   * the comment "Original always sent SABM and went to state 1 … my
   * enhancement". Delete once `ax25sdl` ships a figc4.1/figc4.2 carrying the
   * version branch. Mirrors `Ax25SessionQuirks.Ax25Spec44Mod128ConnectRoutesToV22`
   * in m0lte/packet.net (PR #268).
   */
  ax25Spec44Mod128ConnectRoutesToV22: boolean;

  /**
   * Work around `packethacking/ax25spec#45`: figc4.6's `FRMR received` handler
   * (t14) draws `Establish Data Link` *before* `set_version_2_0`. The inlined
   * `Establish_Data_Link` branches on `ctx.isExtended` (mirroring figc4.7's
   * `mod_128` test), so while the link is still extended the §975 v2.0 fallback
   * re-establishes with a **SABME** — but a FRMR (which only a pre-v2.2 peer
   * sends) is precisely the signal to drop to v2.0/SABM. So the fallback as drawn
   * fails against a real v2.0 peer (it re-sends SABME → another FRMR/DM) and
   * produces a modulo split against a v2.2 peer (re-establish SABME, but the
   * initiator proceeds mod-8 via the later `set_version_2_0`).
   *
   * When `true` (default), the `AwaitingV22Connection` `FRMR_received` transition
   * forces version 2.0 (`isExtended = false`) *before* its actions run (in
   * {@link SdlSessionDriver}'s dispatch path, `applyPreExecutionQuirks`), so
   * `Establish_Data_Link` emits a **SABM** and the fallback genuinely
   * re-establishes as v2.0; the figure's own later `set_version_2_0` is then a
   * no-op. When `false`, the figure runs as drawn (re-establish SABME). De-facto
   * corroboration: direwolf's FRMR handler calls `set_version_2_0` before
   * `establish_data_link` ("Erratum: Need to force v2.0. This is not in flow
   * chart." — `ax25_link.c`, state_5). Only meaningful once
   * {@link Ax25SessionQuirks.ax25Spec44Mod128ConnectRoutesToV22} makes figc4.6
   * reachable by an initiator. Delete once `ax25sdl` ships a figc4.6 t14 with the
   * actions reordered. Mirrors
   * `Ax25SessionQuirks.Ax25Spec45FrmrFallbackReestablishesV20` in
   * m0lte/packet.net (PR #269).
   */
  ax25Spec45FrmrFallbackReestablishesV20: boolean;

  /**
   * Work around `packethacking/ax25spec#47`: figc4.5 (Timer Recovery) draws the
   * in-sequence `I_received` stored-frame drain loop body with
   * `V(r) := V(r) - 1`, where the structurally-identical figc4.4 (Connected)
   * handler — same path, same pre-loop `V(r) := V(r) + 1`, same
   * `loop_while i_vr_i_frame_stored` body — uses `V(r) := V(r) + 1`. The drain
   * delivers each consecutively-stored (previously SREJ-gap-filled) frame and
   * must *advance* V(R) past it; the decrement cancels the pre-loop increment the
   * moment one stored frame is drained, so a station recovering an SREJ gap
   * *while in Timer Recovery* delivers the gap-filled frames but leaves V(R)
   * pointing back at an already-delivered sequence number. The peer's next
   * genuine (still-unacknowledged-window) retransmit is then taken for new data
   * and **re-delivered**, and the link fails to converge — reproduced under
   * SIMULTANEOUS bidirectional SREJ at low n (k = 4): A delivers the peer's
   * two-frame stream twice (`[0x80, 0x81, 0x80, 0x81]`).
   *
   * When `true` (default), the figc4.5 stored-frame drain advances V(R) — the
   * loop-body `V(r) := V(r) - 1` verb is rewritten to `V(r) := V(r) + 1` in the
   * {@link ActionDispatcher} — matching figc4.4 and §6.4.2.1 ("accepts the
   * received I frame, increments its receive state variable"), so a
   * Timer-Recovery stored-frame drain leaves V(R) correctly past the delivered
   * frames. The verb `V(r) := V(r) - 1` appears *only* in these three figc4.5
   * drain loops (no other transition uses it — verified against the `ax25sdl`
   * tables: 3 occurrences, all in `timer_recovery.g`), so the rewrite is
   * precisely scoped and inert everywhere else. When `false`
   * ({@link strictlyFaithfulSessionQuirks}), the figure runs as drawn (the
   * decrement, reproducing the duplicate-delivery / non-convergence for strict
   * conformance study). De-facto corroboration: direwolf's `dl_data_indication`
   * drain (`ax25_link.c`) advances `state->vr` as it pulls each stored frame off
   * `rxdata_by_ns[]` — it never decrements. figc4.4 being already correct is the
   * proof the figc4.5 `-` should be `+`. Delete once `ax25sdl` ships a corrected
   * figc4.5. Mirrors `Ax25SessionQuirks.Ax25Spec47TimerRecoveryDrainAdvancesVR`
   * in m0lte/packet.net (PR #286).
   */
  ax25Spec47TimerRecoveryDrainAdvancesVR: boolean;
}

/**
 * Default preset — spec-*correct* behaviour (all quirks on). This is what
 * a session uses unless explicitly configured otherwise. Mirrors
 * `Ax25SessionQuirks.Default` in m0lte/packet.net.
 */
export const defaultSessionQuirks: Ax25SessionQuirks = {
  segmentFirstCarriesL3Pid: true,
  ax25Spec38SrejSelectiveRetransmit: true,
  ax25Spec40DiscardOutOfWindowIFrames: true,
  ax25Spec41KarnSrtSampling: true,
  ax25Spec42SrejTargetsGap: true,
  ax25Spec43DlFlowOffEntersBusy: true,
  ax25Spec44Mod128ConnectRoutesToV22: true,
  ax25Spec45FrmrFallbackReestablishesV20: true,
  ax25Spec47TimerRecoveryDrainAdvancesVR: true,
};

/**
 * Every quirk off — execute the SDL figures exactly as drawn, including
 * known defects. For strict conformance testing against the published
 * figures, not for on-air use. Mirrors `Ax25SessionQuirks.StrictlyFaithful`
 * in m0lte/packet.net.
 */
export const strictlyFaithfulSessionQuirks: Ax25SessionQuirks = {
  segmentFirstCarriesL3Pid: false,
  ax25Spec38SrejSelectiveRetransmit: false,
  ax25Spec40DiscardOutOfWindowIFrames: false,
  ax25Spec41KarnSrtSampling: false,
  ax25Spec42SrejTargetsGap: false,
  ax25Spec43DlFlowOffEntersBusy: false,
  ax25Spec44Mod128ConnectRoutesToV22: false,
  ax25Spec45FrmrFallbackReestablishesV20: false,
  ax25Spec47TimerRecoveryDrainAdvancesVR: false,
};
