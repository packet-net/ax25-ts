# Changelog

All notable changes to `@packet-net/ax25` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Subject lines stay short by convention; bodies wrap to the GitHub viewer's viewport.

## [Unreleased]

### Added

- **MDL XID parameter-negotiation runtime** — the TS parity leg of the v2.2 arc V3 part 2 (mirrors packet.net#271), closing V3 across both runtimes. A new `Ax25ManagementDataLink` driver (`src/sdl/management-data-link.ts`) runs the management data-link FSM — figc5.1 `Ready` / figc5.2 `Negotiating`, from the new `management_data_link` machine in ax25sdl 0.9.0 (exported as `ManagementDataLinkReady` / `ManagementDataLinkNegotiating`) — through the *same* `SdlSessionDriver` / `ActionDispatcher` / `GuardEvaluator` machinery the data-link uses (a proportionate 2-state reuse, not a second interpreter): the driver is now parameterised by an optional `statePages` map + MDL dispatcher hooks + extra guard bindings, defaulting to the data-link behaviour so existing sessions are unaffected. The MDL machine runs against its own isolated `Ax25SessionContext` (its `RC` / `NM201` / `TM201` never disturb the live data-link `RC` / T1/T2/T3 — `NM201` maps onto the MDL context's `n2`, `TM201` is a new distinct timer name added to `TimerName` so a shared scheduler never collides), and applies the *negotiated* parameters to the **real** data-link context — turning SREJ / segmentation / modulo / window / T1 / N2 from config-flag-forced defaults into negotiated link parameters. New MDL dispatcher hooks (`sendXidCommand` / `applyNegotiatedParameters` / `sendMdl` / `setVersion20` / `onMdlNegotiateRequest`) ride on the `ActionDispatcher` (no-op / data-link defaults otherwise), and the new MDL verbs get dispatch arms (`XID_command`, `Start`/`Stop TM201`, `Apply Negotiated Parameters`, `MDL_NEGOTIATE_confirm`, `MDL_ERROR_indicate_B/C/D`); the shared `set_version_2_0` verb now routes through the `setVersion20` hook (data-link default clears `isExtended` only; the MDL override installs the full §1436 set). `src/sdl/xid-negotiator.ts` implements the §6.3.2 "reverts-to" merge (`applyNegotiated`) per parameter — HDLC Optional Functions (reject scheme + modulo) → **lesser** of the two offers so SREJ/mod-128 survive only if both sides offer them (§6.3.2 ¶1426); Classes of Procedures (duplex) → lesser (¶1424); Window k + N1 → notification/**min** (¶1428/¶1430); Ack Timer T1 + Retries N2 → **greater** (¶1432/¶1434); the segmenter/reassembler bit → mutual-capability AND (¶1419); a field absent from both offers retains the context's current value (¶1024) — plus `applyVersion20Defaults`, the full §1436 version-2.0 default set installed on a FRMR-of-XID (half-duplex, implicit reject, **mod-8**, N1=256 octets, **k=7** — the §1436 fallback value, NOT the mod-8 XID offer default of 4 — T1=3000 ms, N2=10; not merely clearing the extended flag). Integration: the data-link figc4.6 UA-received path raises `MDL-NEGOTIATE Request` after a successful v2.2 connect, which `Ax25Listener` (and the two-station harness) routes to the session's MDL driver to open the XID exchange (send XID command, start TM201, → Negotiating); inbound XID / FRMR-of-XID frames are routed to the MDL while it negotiates, disambiguating XID **command** vs **response** by the C/R bit — command → responder (the un-transcribed figc5.1 `respondToXidCommand` helper: merge per §6.3.2, reply with an XID response F=1 carrying the agreed values), response while negotiating → apply, FRMR while negotiating → v2.0 fallback. New `xid()` / `frmr()` frame factories + `"XID"` / `"FRMR"` classification (U-frame control 0xAF / 0x87, info-bearing, no PID); a new `segmenterReassemblerEnabled` context flag. The MDL pages are a prose-derived bootstrap (hand-authored upstream from §6.3.2 + App-C5.3 prose; figc5.x never redrawn, marked `verification_pending`); the figc5.3–figc5.8 per-parameter reverts-to subroutines are collapsed to a single `Apply Negotiated Parameters` placeholder whose runtime body `src/sdl/xid-negotiator.ts` supplies, and the figc5.1 responder column is the explicitly-untranscribed `respondToXidCommand` helper — both flagged to fold onto the SDL at the figc5.x backfill. New `tests/xid-negotiator.test.ts` (16 tests: per-parameter merge + the §1436 set), `tests/conformance/mdl-xid-negotiation.test.ts` (9 tests: two-station XID convergence with five concrete reverts-to merges pinned, v2.0 FRMR fallback incl. k=7, TM201/NM201 exhaustion → MDL-ERROR (C), error D/B paths), and `tests/Ax25ListenerMdl.test.ts` (the production-listener figc5.1 responder path end-to-end); the two-station harness gained per-station MDL drivers + a deferred MDL-work queue (models the async modem boundary so a just-sent XID command's MDL transition commits before its reply is handled), `startNegotiation` / `advanceTm201` drive methods, and per-station `mdlSignals`. The existing mod128-establishment suite's "every establishment frame is a SABME" assertion now filters to SABM/SABME, since a successful v2.2 connect is followed by the MDL's (legitimate) XID command.

- **XID information-field (TLV) codec** — the TS parity leg of the v2.2 arc V3 part 1 (mirrors packet.net#270). A new `src/xid.ts` module encodes/decodes the AX.25 v2.2 XID parameter-negotiation *information field* — the TLV payload carried inside an XID U-frame (§4.3.3.7, parameter table Fig 4.5, worked example Fig 4.6): `encodeXid(params)` builds FI(0x82) + GI(0x80) + GL + ordered PI/PL/PV triples; `tryParseXid(info, options?)` decodes them back, returning a `{ ok, parameters } | { ok, reason }` discriminated union (no throw on malformed input), strict-by-default with named `XidParseOptions` leniency knobs (`allowGroupLengthOverrun` / `allowTruncatedParameter`, both off by default — the `XID_PARSE_STRICT` / `XID_PARSE_LENIENT` presets) per the repo's spec-compliant-by-default philosophy; the encode path is unconditionally strict and never emits a malformed field. Covers the six AX.25 parameters: Classes of Procedures (PI=2, duplex), HDLC Optional Functions (PI=3, REJ/SREJ + modulo-8/128 + segmenter/SREJ-multiframe — the bit-fields force the spec-mandated always-1/always-0 bits), I-Field Length Rx (PI=6, in bits; `iFieldLengthRxOctets()`/`octetsToBits()` convert to/from the session's octet N1), Window Size Rx (PI=8), Ack Timer T1 (PI=9, ms), Retries N2 (PI=10). Absent parameters are modelled as `undefined` on `XidParameters` (= "use the currently-negotiated value", ¶1024) — distinct from a present-but-default value; the Tx variants PI=5/PI=7 (ISO-8885-only) and any unrecognised PI are skipped on parse. Bit-to-octet mapping is LSB-first within each octet (octet 0 first), verified independently against Fig 4.6 byte-for-byte; the codec follows the normative §4.3.3.7 table/prose over the two documented Fig 4.6 worked-example discrepancies — the Classes-of-Procedures Balanced-ABM bit sits at bit 0 (encoding 0x21, not the figure's 0x22 which mis-places it at bit 1), and the HDLC field's bytes 0x82 0xA8 0x22 literally select REJ (bit 1), not the SREJ its caption claims (we decode the bytes faithfully). New `tests/xid.test.ts` (51 tests): header/PI constants pinned to spec, an independent hand-decode of the Fig 4.6 PV bit positions, the Fig 4.6 worked example parsed field-by-field and re-encoded byte-for-byte (modulo the spliced ABM anomaly), per-parameter round-trips, absent-field handling, malformed/short-buffer rejection, and the strict-rejects/lenient-accepts pairs the repo requires for any parser leniency. This is the codec **only** — the MDL/XID negotiation FSM (figc5.1–5.8, not transcribed in `m0lte/ax25sdl`) and wiring into the session are V3 part 2, a follow-up; ax25-ts has no XID U-frame factory yet, so the codec is transport-agnostic and its output is exercised through a generic frame's encode→wire→decode round-trip.

- **Extended (mod-128) frame codec** — the TS parity leg of the v2.2 arc V1 (mirrors packet.net#266 / toward packet.net#239). `Ax25Frame` gains a `controlExtension` octet (the second control octet of an extended I/S frame — 7-bit N(R) in bits 7-1, P/F in bit 0 per Fig 4.1b; `null` for U frames and all mod-8 frames, surfaced as `isExtendedControl()`). `pollFinal()` is now mode-aware — bit 4 of the control octet under mod-8 and for U frames (1 octet in both modes), but bit 0 of the second control octet for an extended I/S frame (the common get-it-wrong bug). New mode-aware `getNs()`/`getNr()` extract 3-bit (mod-8) or 7-bit (mod-128) sequence numbers from the frame's own control width, so the dispatcher and guard bindings read them without re-deriving bits. The `iFrame`/`rr`/`rnr`/`rej`/`srej` factories take an `extended` flag (a new optional field, so existing callers are unaffected) and emit the 2-octet control field; the dispatcher passes `ctx.isExtended`. `decodeFrame` takes an `extended` parameter — an I/S control field's width isn't derivable from the octets alone, so the receive path threads the session's negotiated modulo: the `Ax25Listener` inbound pump parses at mod-8 for routing (addresses precede the control field and are modulo-independent), then re-decodes I/S frames at the matched session's modulo (`reparseAtSessionModulo`); `Ax25Stack` threads the modulo through `_handleFrame` the same way. `Establish_Data_Link` now emits SABME on an extended link (figc4.7 `mod_128` path) so the peer keeps mod-128, and the two-station conformance harness runs a full windowed mod-128 transfer (8 frames, k=8) to convergence. The classifier is unchanged — it reads only the first control octet's I/S/U + S-subtype discriminators, identical in both modulos. New `tests/frame-extended.test.ts` pins the spec octets for I and S frames, round-trips 7-bit N(S)/N(R) across the full 0–127 range, shows a wrong-modulo parse mis-frames, and regression-pins mod-8; the previously-skipped mod-128 transfer conformance test is un-skipped and green. What's still out: the driver doesn't yet *originate* mod-128 negotiation on its own (it doesn't flip `isExtended` from an inbound SABME) — that lands with V4.

- **SABME establishment + version negotiation** — the TS parity leg of the v2.2 arc V2 (mirrors packet.net#268/#269). Connect-initiation already emitted SABME vs SABM correctly (the inlined `Establish_Data_Link` branches on `ctx.isExtended`), but figc4.1/figc4.2 route the `Disconnected` DL-CONNECT path **unconditionally to `AwaitingConnection`** with no version branch (confirmed against the authoritative `DataLink_Disconnected.graphml` in `m0lte/ax25sdl` — version routing exists only on the responder SABM/SABME-received side). So a v2.2-preferred connect sent the right first frame but parked in the mod-8 state, whose T1 retry downgrades to SABM (figc4.2 `t05`) and which has no FRMR handler (so the §975 v2.0 fallback couldn't fire). Two new default-on quirks correct the figures in the runtime (off under `strictlyFaithful`): **`ax25Spec44Mod128ConnectRoutesToV22`** ([packethacking/ax25spec#44](https://github.com/packethacking/ax25spec/issues/44)) rewrites just that one transition's *target state* to `AwaitingV22Connection` (figc4.6) when `isExtended` at dispatch time — a new quirk shape (the existing #40/#42/#43 rewrite *guards*; this rewrites `next`, in `SdlSessionDriver.resolveNextState`); and **`ax25Spec45FrmrFallbackReestablishesV20`** ([packethacking/ax25spec#45](https://github.com/packethacking/ax25spec/issues/45)) forces version 2.0 (`isExtended = false`) *before* the figc4.6 t14 FRMR actions run (in `SdlSessionDriver.applyPreExecutionQuirks`), so the §975 fallback re-establishes with a SABM not a SABME (t14 draws `Establish Data Link` before `set_version_2_0`; since Establish branches on the modulo, the fallback as drawn re-sends SABME while still extended — useless against the pre-v2.2 peer that just FRMR'd). Both mirror direwolf's `ax25_link.c` (the `state_5 ? : state_1` connect routing, and `set_version_2_0` "not in flow chart" before `establish_data_link` in the FRMR handler). figc4.6 then drives the handshake: retry resends SABME, FRMR → v2.0 + re-establish (SABM → `AwaitingConnection`, mod-8), DM(F=1) → teardown, UA → Connected-extended. The driver's `STATE_PAGES` is now keyed by the figc4.6 page's real SDL name `AwaitingV22Connection` (it was mis-keyed `AwaitingConnection22` while nothing could route into it; the #44 redirect makes it reachable for the first time). The two-station harness gained a `quirks`/`buildStrictlyFaithful` knob, an `inject` (channel-bypassing event injection for the FRMR/DM rejections), per-endpoint `receivedFromPeer`/`signals` logs, and a `firedTransitions` ledger (fed by a new `onTransitionFired` driver hook — the TS analogue of the C# `Ax25Session.TransitionFired` event). New `tests/conformance/mod128-establishment.test.ts`: route-through-AwaitingV22Connection, lost-SABME-retried-as-SABME-not-SABM, FRMR→v2.0-re-establish-as-SABM (the complete mod-8 fallback), DM teardown, and a `strictlyFaithful` pin reproducing the figc4.2 defect. ax25-ts has no `Ax25SessionQuirks`-style central session record like the C# side — the quirk facility is the `Ax25SessionQuirks` *interface* + `defaultSessionQuirks`/`strictlyFaithfulSessionQuirks` presets in `src/sdl/session-quirks.ts`, which both new flags extend; the two corrections are wired directly into the driver's dispatch path.

### Changed

- Bump the `ax25sdl` dependency to `^0.9.0`, which adds the `management_data_link` SDL machine (states `Ready` / `Negotiating`) consumed by the new MDL runtime above.

## [0.5.1] — 2026-06-02

### Added

- **`ax25Spec43DlFlowOffEntersBusy` quirk** (default-on; off under `strictlyFaithful`). figc4.4 as drawn gates DL-FLOW-OFF's Set-Own-Receiver-Busy / RNR actions on the *already-busy* (`Own Receiver Busy? = Yes`) branch, so a not-busy station receiving DL-FLOW-OFF never enters the busy condition — the primitive can't establish flow control from a clean state. The quirk inverts the `own_receiver_busy` guard for the `DL_FLOW_OFF_request` trigger only (inert elsewhere), so DL-FLOW-OFF sets own-receiver-busy and sends RNR, the peer registers peer-busy and pauses, and DL-FLOW-ON resumes the flow. Rests on §6.4.10 (entering a busy condition → RNR) and the correct FLOW-ON mirror; no de-facto corroboration (neither direwolf nor linbpq implements DL-FLOW-OFF). Mirrors packet.net libs 0.4.1 (packethacking/ax25spec#43). New `setBusy`/`clearBusy` harness controls + an RNR-flow-control conformance test (the sender pauses on the peer's RNR and resumes on its RR).

## [0.5.0] — 2026-06-02

Connected-mode **data transfer and full loss recovery** now work — the headline gap since the repo split. ax25-ts reaches parity with the packet.net reference runtime for mod-8 connected-mode operation.

### Added

- **figc4.7 subroutine walker.** The subroutine registry now table-walks `Enquiry_Response`, `Select_T1`, `Invoke_Retransmission`, `Transmit_Enquiry`, `Check_I_Frame_Acknowledged`, etc. (it was a permanent no-op). A receiver now acknowledges data — the figc4.4 delayed-ack RR flushes on `LM_SEIZE_confirm`, granted immediately for a contention-free single session — so connected-mode **data transfer converges** for the first time (closes #12).
- **Loss recovery (REJ + SREJ).** Timeout-driven go-back-N (`Transmit_Enquiry` → `Invoke_Retransmission`) and single-frame selective reject over a real **SREJ frame on the wire** — `srej()` factory + `classify()` recognition (§4.3.2.4) (closes #10).
- **SREJ recovery quirks** `ax25Spec40` (out-of-window discard), `ax25Spec41` (Karn SRT sampling), `ax25Spec42` (SREJ targets the gap V(R), not the just-arrived frame) — default-on, off under `strictlyFaithful` — mirroring packet.net libs 0.4.0 (packethacking/ax25spec#40/#41/#42).
- **Dynamic T1.** `Select_T1` un-stubbed: the SRT/T1V IIR runs, Karn-guarded by `ax25Spec41` so it stays bounded.
- **Loss-recovery conformance suite.** Drop filter + `advanceT1` + a generative single-drop / bidirectional-burst sweep across both modes, asserting convergence (windows empty + complete in-order delivery). The heavy burst livelocks only under `strictlyFaithful`, proving the quirks are load-bearing.

### Fixed

- The subroutine registry had no verb-alias layer, so calls spelled with spaces (`Invoke Retransmission`, `Enquiry Response (F = 0)`) silently missed the underscore-keyed registry and did nothing — no acknowledgement, no recovery.
- The two-station conformance harness shared one timer scheduler across both stations, so one station's `Stop T1` cancelled the other's pending T1 and masked recovery — now per-station (shares only the clock, like the C# harness).
- The LinBPQ `IFrame_RoundTrip` interop test is un-skipped — it was filed as a flake (packet.net#153) but was the data-transfer gap; it now round-trips against the live stack (closes packet.net#153).

## [0.4.2] — 2026-06-02

### Fixed

- Connected-mode retransmitted I-frames now keep their **original N(s)** instead of being renumbered with a fresh one. The I-frame transmit queue holds `(data, pid)` with no N(s); the drain that pops it fires `I_frame_pops_off_queue`, which assigns `N(s) := V(s)` + increments V(s) — correct for a *fresh* frame, but it renumbered *retransmitted* frames that the recovery verbs re-queued onto the same queue, so the peer never recognised a resend as the missing frame and no single lost I-frame was recoverable (the link stormed, then disconnected on N2). The retransmit verbs (`Push Old I Frame N(r) on Queue` — figc4.4 selective SREJ/REJ, plus its Ax25Spec38-quirk redirect target — and figc4.7's `Push Old I Frame onto Queue`) now emit directly with their original N(s) (`N(r) := V(r)`, P=0), unconditionally, bypassing the fresh-frame drain. Mirrors the C# fix in `ActionDispatcher.EmitOldIFrame` (M0LTE/packet.net#231 / #232). New `tests/DataLinkSrejUnderLoss.test.ts` reproduces the renumbering and proves selective recovery.

## [0.4.1] — 2026-05-28

Consumes `ax25sdl` 0.7.1, which fixes the figc4.5 Timer-Recovery recovery-complete guard (ax25sdl#53) — found on-air via packet.net#214. The decision is drawn after `V(a) := N(r)`, so it tests `V(s) = N(r)`; the table had flattened it to a pre-action guard reading the stale `V(a)`, so a poll response that acked everything (`N(r) = V(s)`) mis-routed to retransmission and recovery never completed. The canonical behavioral regression lives in the C# reference runtime (packet.net).

### Changed

- Bump the `ax25sdl` dependency to `^0.7.1`.

### Added

- Bind the `vs_eq_nr` predicate (`V(s) == N(r)`) that the 0.7.1 tables now emit on the recovery-complete paths — the same comparison as `n_r_eq_v_s`.

## [0.4.0] — 2026-05-28

> Note: `0.3.0` was published in error from `main` before this change merged, so it carries the old `ax25sdl ^0.6.0` dependency and **does not** include SDL loop execution. It is deprecated on npm — use `0.4.0` or later.

Consumes `ax25sdl` 0.7.0, which recovers the AX.25 SDL loops the codegen had previously been dropping (ax25sdl#44/#48/#49). The session runtime now *executes* those loops instead of running each body once — the TypeScript mirror of the C# `SdlLoopExecutor` work in `m0lte/packet.net`.

### Changed

- Bump the `ax25sdl` dependency to `^0.7.0`.

### Added

- SDL loop execution in the session driver: a transition's `loop_while` ranges (the figc4.4 / figc4.5 stored-frame drain) are now expanded — a head-test loop re-checks its continue predicate before each iteration (zero-or-more runs), a tail-test after (one-or-more) — with an iteration cap that throws rather than spinning. Subroutine bodies are still not table-walked in this port, so only transition loops apply.
- Stored-frame drain support: `Retrieve Stored V(r) I Frame` now consumes the stored frame at V(r) and stages it for the following `DL-DATA Indication` to deliver (the retrieve/deliver split the figure draws as two actions, avoiding double-delivery); plus `V(r) := V(r) - 1` (figc4.5) and the `vr_I_frame_stored` loop-predicate binding.

### Fixed

- An in-sequence I-frame arriving in Connected or Timer Recovery no longer throws `UnknownActionError` on the drain loop's `Retrieve Stored V(r) I Frame` verb — which surfaced the moment the 0.7.0 tables started carrying the recovered loop.

## [0.2.1] — 2026-05-17

Lifts the friendly facade methods (`onData`, `onDisconnected`, `write`, `disconnect`, `to`) onto `Ax25ListenerSession`, so a session from `Ax25Listener.connect()` or `Ax25Listener.onSessionAccepted` is now drop-in compatible with one from `Ax25Stack.connect()`. Consumers that just want the high-level shape no longer need to write adapter code on top of `Ax25ListenerSession`'s raw `postEvent` / `onDataLinkSignal` API — the raw API stays available for advanced use. Surfaced by the packet-terminal example modernization (issue: the example would otherwise have had to reimplement what `Ax25Session` already provides).

`@packet-net/ax25` and the `ax25sdl` companion package bump in lockstep to `0.2.1`. No breaking API changes — additions only.

### Added

- **`Ax25ListenerSession.to`** — getter for the peer callsign (convenience for `context.remote`). Same shape as `Ax25Session.to`.
- **`Ax25ListenerSession.onData(cb)`** — register a callback invoked with the I-frame info bytes whenever a `DL_DATA_indication` (or `DL_UNIT_DATA_indication`) signal fires. Same shape as `Ax25Session.onData`.
- **`Ax25ListenerSession.onDisconnected(cb)`** — register a callback invoked when the session enters Disconnected (either `DL_DISCONNECT_indication` or `DL_DISCONNECT_confirm`). Same shape as `Ax25Session.onDisconnected`.
- **`Ax25ListenerSession.write(chunk, pid?)`** — queue a payload for transmission as an I-frame. Throws if not Connected; resolves once bytes are accepted to the local TX queue. Default PID `0xF0` (no-layer-3); custom PID supported (NET/ROM, IP, etc.). Same shape as `Ax25Session.write` plus the optional PID parameter.
- **`Ax25ListenerSession.disconnect()`** — initiate disconnect; resolves on the next `DL_DISCONNECT_confirm` or `DL_DISCONNECT_indication`. Already-disconnected sessions resolve immediately. Same shape as `Ax25Session.disconnect`.

### Test count

- Unit tests +9 in `Ax25ListenerSessionFacade.test.ts` — coverage for each of the five facade methods plus edge cases (empty-buffer write, write-while-disconnected, custom PID, idempotent disconnect).

## [0.2.0] — 2026-05-16

Adds the `Ax25Listener` class — `@packet-net/ax25` can now act as an inbound-accepting node, the single most valuable parity gap with the C# runtime. Plus two bug-fix carries from the C# runtime that were never quite right in TS either.

`@packet-net/ax25` and the `ax25sdl` companion package bump in lockstep to `0.2.0`. No breaking API changes; `Ax25Stack` and `Ax25Session` keep their existing outbound-only shape (the listener is a sibling class, not a replacement).

### Added

- **`Ax25Listener`** — first-class inbound-acceptance coordinator. Owns one `Ax25Transport`, address-filters inbound frames against `myCall`, dispatches to the per-peer `Ax25ListenerSession` (creating one on first contact — inbound SABM or outbound `listener.connect(remote)`), surfaces `sessionAccepted` + `frameTraced` events, and runs an LRU cache of cached sessions keyed by peer callsign (default cap 64). Mirrors `Packet.Ax25.Session.Ax25Listener` from the C# runtime.
- **`acceptIncoming` toggle** on `Ax25Listener` — flip to `false` to refuse all new incoming SABMs; existing sessions keep running. The listener responds with DM (figc4.1 t15) to the rejected SABM and doesn't cache the transient session.
- **Per-peer session cache** — sessions survive disconnect; the same `Ax25ListenerSession` instance is handed back on reconnect, preserving SRT/T1V smoothing and any out-of-SDL context state (e.g. `sentIFrames` between reconnect attempts).
- **Handler-exception isolation** (#140 carry-over) — every `sessionAccepted` / `frameTraced` subscriber is invoked inside a try/catch; exceptions are routed to a configurable `onHandlerError` sink (default `console.error`) and never escape the inbound pump. A buggy consumer cannot DoS the modem.
- **`Callsign`-aware `connect()`** on the listener — initiate an outbound SABM against a peer using the same per-peer cache; resolves to the session once DL-CONNECT-confirm arrives.
- **SABME factory + classifier branch** — `frame.ts` exports a `sabme(...)` factory and `classify(...)` recognises control byte 0x6F. The full mod-128 sequence-number path remains gated on the `version_2_2` predicate (still effectively false in this runtime); the addition is purely so listener tests can inject SABME and exercise figc4.1's t16 branch.

### Fixed

- **#141 carry-over: via-chain reversal on responses.** `ActionDispatcher`'s outbound frame builders now reverse the inbound trigger's digipeater chain when emitting UA / DM / RR / RNR / REJ / I / UI responses. A peer behind a two-hop digipeater chain (`[GB7CIP, MB7UR]`) sending SABM now gets UA back via the reversed chain (`[MB7UR, GB7CIP]`), per AX.25 v2.2 §C.2 Path Construction. Previously the UA had no via-chain on the wire, so the digi closest to the responder never forwarded it.
- **#143 carry-over: cache-miss DM for non-SABM frames.** When the listener receives a non-SABM frame addressed to us from a peer with no cached session (DISC / RR / RNR / REJ / SREJ / I / FRMR / XID / TEST), it now builds a transient Disconnected session, dispatches the event so the SDL's per-event arm fires (DISC → t13 → DM; everything else → t05 all_other_commands → DM), then drops the transient session without caching it. Previously these frames were silently dropped at the cache-miss filter, leaving the peer's half-open session view hanging.

### Test count

- Unit tests +30 across `Ax25Listener.test.ts` (5), `Ax25ListenerConcurrency.test.ts` (7), `Ax25ListenerMultiPeer.test.ts` (7), `Ax25ListenerRejectAndEdge.test.ts` (10), and `ActionDispatcherViaChain.test.ts` (1) — 1:1 mirror of the 30 C# listener tests.
- Integration tests +3 across `listener-netsim-multi-peer.test.ts` (2) and `listener-linbpq-initiates.test.ts` (1).

### Known limitations

- Per-peer cache is single-threaded (JS is); the C# listener uses a `ConcurrentDictionary` for the same role. The TS surface is event-driven on a single event loop, so the C# concurrency primitives are unnecessary.
- The listener-owned session class is exported as `Ax25ListenerSession` to avoid name-collision with the existing `Ax25Session` from `Ax25Stack`. Functionally similar (both wrap an `SdlSessionDriver`) but the API surfaces differ — `Ax25Session` exposes outbound-flavoured `connect` / `write` / `disconnect`; `Ax25ListenerSession` exposes raw `postEvent` + signal subscription.

## [0.1.1] — 2026-05-16

Documentation fix. No code changes — `0.1.1` ships only to scrub a stale pre-publish notice that leaked into `0.1.0`'s `README.md` (a `> [!NOTE]` callout claiming the package was not yet on npm, which is wrong now that `0.1.0` has shipped). Republishing flushes the notice off the npmjs.com package page.

### Changed

- README: removed the pre-publish "not yet on npm" callout. `0.1.0`'s README on npmjs.com still shows it; consumers should pull `^0.1.1`.

## [0.1.0] — 2026-05-16

First public release. Covers AX.25 v2.2 connected-mode happy-path interop with LinBPQ, Xrouter, rax25, and direwolf-style KISS-TCP listeners. Published to npmjs.com from the self-hosted CI runner.

### Added

- **Frame codec** for U-frames (SABM, UA, DISC, DM, UI), S-frames (RR, RNR, REJ), and I-frames. Mod-8 only.
- **`Callsign`** value type — 0-6-char base + 0-15 SSID. `Callsign.parse("M0LTE-7")` round-trips.
- **`Ax25Address`** record + codec — 7-octet on-the-wire callsign with SSID + C/H + E-bit handling.
- **KISS framing** — `KissDecoder` (stateful FEND/FESC/TFEND/TFESC decoder) and `encodeKiss(...)`. Multi-port nibble supported.
- **`Ax25Transport`** — 3-method interface (`start` / `send` / `stop`) — the seam future transports plug into.
- **`WebSerialKissTransport`** — KISS over a `SerialPort` for Chromium browsers.
- **`TcpKissTransport`** — KISS over a TCP socket for Node.js. Reachable via the `@packet-net/ax25/tcp-transport` subpath import so browser bundlers don't pull in `node:net`.
- **`Ax25Stack`** + **`Ax25Session`** — public connected-mode API. `connect({ from, to })` returns a `Promise<Ax25Session>` once SABM/UA completes; the session exposes `onData(cb)`, `onDisconnected(cb)`, `write(bytes)`, and `disconnect()`.
- **Table-driven session machine** — the driver in `src/sdl/session-driver.ts` imports `DataLinkDisconnected`, `DataLinkAwaitingConnection`, `DataLinkAwaitingConnection22`, `DataLinkConnected`, and `DataLinkAwaitingRelease` transitions from the [`ax25sdl`](../../ts-spec/) package, evaluates guards via `src/sdl/guard-evaluator.ts`, executes action chains via `src/sdl/action-dispatcher.ts`, and advances state. Same architecture as the C# runtime in `src/Packet.Ax25/Session/`.
- **T1 retry** on SABM, DISC, and outstanding I-frame, capped at N2 (default 10) via the SDL `RC_eq_N2` guard.
- **First live interop** — integration test against LinBPQ over net-sim (`tests/integration/linbpq-via-netsim.test.ts`) — SABM/UA → I-frame round-trip → DISC/UA, full wire-log evidence captured in [`docs/plan.md`](../../docs/plan.md) amendment log.

### Changed

- Renamed package from `@packet-net/ax25-ts` to `@packet-net/ax25`. Pre-publish rename; no released versions of the `-ts` name exist on npm.

### Known limitations

- **k=1 single-outstanding-I-frame window** — throughput will be SRT-bound on real links.
- **REJ/SREJ recovery loops** — wire frames emit, but the recovery subroutines are no-op stubs (figc4.7 paths not yet walked).
- **Dynamic T1V** — `Select_T1_Value` is a stub; caller-supplied `t1Ms` is honoured statically.
- **No FRMR generation / handling** — inbound FRMR silently dropped.
- **No mod-128 (SABME)** — the SDL `version_2_2` predicate returns false.
- **`via` digipeater paths** — frame factories and codec round-trip them, but `stack.connect({ via: [...] })` throws.
- **No AGW / AXUDP / audio transports** — Web Serial + TCP only.
- **No inbound connection acceptance** — SABM addressed to us with no matching outbound session is silently dropped.

See [README.md § Scope](README.md#scope--whats-in-v01-whats-deliberately-out) for the full out-of-scope table.

[0.1.0]: https://github.com/M0LTE/packet.net/releases/tag/v0.1.0
