# Changelog

All notable changes to `@packet-net/ax25` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Subject lines stay short by convention; bodies wrap to the GitHub viewer's viewport.

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
