# `@packet-net/ax25`

Browser-targeted TypeScript library for AX.25 v2.2 connected-mode sessions over KISS modems. Open a connection to a remote callsign, get back a bidirectional `Stream`-ish session with `onData(...)`, `write(...)`, and `disconnect()`. The library walks the generated AX.25 SDL state-machine tables verbatim — no prior amateur-radio-app-development experience required to use it.

```sh
npm install @packet-net/ax25
```

## Find your use case

| I want to… | Read | Worked example |
| --- | --- | --- |
| Build a **web terminal** (connect to a BBS/node from a browser, type lines, read replies) | [Quick start](#quick-start-web-serial) | [`examples/web-terminal.ts`](examples/web-terminal.ts) |
| **Make a connection programmatically** and send/receive data (Node or browser) | [Quick start](#quick-start-web-serial) + [Transports](#transports) | [`examples/quick-start.ts`](examples/quick-start.ts), [`examples/node-tcp.ts`](examples/node-tcp.ts) |
| **Accept inbound connections** (node/BBS/gateway shape — answer whoever calls in) | [Listening for inbound connections](#listening-for-inbound-connections) | [`examples/inbound-listener.ts`](examples/inbound-listener.ts) |
| **Ping a station / be pingable** without a connection (axping, AX.25 TEST) | [Compatibility profiles & axping](#compatibility-profiles--axping) | — |
| Match a port to a **specific neighbour implementation** (BPQ / XRouter / Dire Wolf), or run spec-strict | [Compatibility profiles & axping](#compatibility-profiles--axping) | — |
| Hear **NET/ROM** routing broadcasts / connect across the network by alias | [Hearing NET/ROM NODES broadcasts](#hearing-netrom-nodes-broadcasts) | [`examples/netrom-aware.ts`](examples/netrom-aware.ts) |
| Unit-test my app **without a radio** | — | [`examples/with-mock-transport.ts`](examples/with-mock-transport.ts) |

## Quick start (Web Serial)

A complete browser app — open a USB modem, connect to `GB7CIP`, send a line, receive replies, disconnect:

```ts
import {
  Ax25Stack,
  Callsign,
  WebSerialKissTransport,
} from "@packet-net/ax25";

// User-gesture-driven port picker (a button's onclick handler, typically):
const port = await navigator.serial.requestPort();

const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
const stack = new Ax25Stack(transport);
await stack.start();

const session = await stack.connect({
  from: Callsign.parse("M0LTE-2"),
  to: "GB7CIP",
});

session.onData((chunk) => console.log(new TextDecoder().decode(chunk)));
session.onDisconnected(() => console.log("link closed"));

await session.write(new TextEncoder().encode("hello\r"));

// Later, when the user clicks "disconnect":
await session.disconnect();
await stack.stop();
```

The same code as a typechecking file lives at [`examples/quick-start.ts`](examples/quick-start.ts). Two more end-to-end examples (Node TCP, in-memory mock for unit tests) live alongside it in [`examples/`](examples/).

## Listening for inbound connections

`Ax25Stack` is outbound-only. For node-style usage (BBS, gateway, automatic forwarder, TUI), reach for `Ax25Listener` — it owns one transport, address-filters inbound frames against your callsign, builds (or reuses) a session on the first SABM from each peer, and surfaces `sessionAccepted` so application code can wire per-session handlers.

```ts
import {
  Ax25Listener,
  Callsign,
} from "@packet-net/ax25";
import { TcpKissTransport } from "@packet-net/ax25/tcp-transport";

const transport = new TcpKissTransport("127.0.0.1", 8100, { kissPort: 0 });
const listener = new Ax25Listener(transport, {
  myCall: Callsign.parse("M0LTE-1"),
});

listener.onSessionAccepted((session) => {
  console.log("inbound from", session.to.toString());

  // The session has the same friendly shape as an outbound Ax25Session —
  // onData / write / onDisconnected / disconnect:
  session.onData((chunk) => {
    process.stdout.write(new TextDecoder().decode(chunk));
  });
  session.onDisconnected(() => console.log("peer disconnected"));

  void session.write(new TextEncoder().encode("Welcome to M0LTE-1\r"));
});

await listener.start();
```

(The raw SDL-layer API — `postEvent` / `onDataLinkSignal` — stays available on the same session object for consumers that need direct access to DL primitives, XID negotiation, or custom error-recovery flows.)

The listener can also **dial out** on the same transport — `listener.connect(remote)` resolves to a session once the handshake completes, reusing the per-peer cache (SRT/T1V history carries over):

```ts
const session = await listener.connect("GB7CIP");
session.onData((chunk) => console.log(new TextDecoder().decode(chunk)));
await session.write(new TextEncoder().encode("?\r"));
```

Per-peer sessions are cached, surviving disconnect — sequence-variable history and SRT/T1V smoothing carry over to the next connect from the same callsign. The cache evicts LRU past `maxCachedPeers` (default 64). Full worked example at [`examples/inbound-listener.ts`](examples/inbound-listener.ts).

## Transports

`Ax25Stack` accepts any `Ax25Transport` (a 3-method interface: `start` / `send` / `stop`). The library ships four concrete transports plus a documented "implement-your-own" seam:

| Transport | Where | Environment | Status |
| --- | --- | --- | --- |
| `WebSerialKissTransport` | main entry | Chromium browsers (Chrome / Edge / Opera / Brave) | ✓ |
| `TcpKissTransport` | `/tcp-transport` subpath | Node.js | ✓ |
| `AxudpTransport` | `/axudp-transport` subpath | Node.js | ✓ |
| `MockTransport` | `tests/mock-transport.ts` | Anywhere (test-only) | ✓ |
| AGW (over TCP) | — | Node | not implemented |
| Audio (browser AFSK) | — | Browser | not implemented |

To roll your own, implement `Ax25Transport` and pass it to `new Ax25Stack(yourTransport)`.

### AXUDP (BPQAXIP-over-UDP)

`AxudpTransport` carries AX.25 frames over UDP to a real AXIP/AXUDP peer — LinBPQ's BPQAXIP driver, XRouter, ax25ipd, JNOS — the RFC-1226 "AX.25 over IP" convention. It's the Node analog of `TcpKissTransport`, plugging into the exact same `Ax25Transport` seam, so the listener + the NET/ROM module run over it identically:

```ts
import { AxudpTransport } from "@packet-net/ax25/axudp-transport";

// Send every frame to the peer at host:port; bind a local UDP port for
// receive (a fixed one if the peer dials us by a known port, e.g. a BPQAXIP
// MAP entry; 0 picks an ephemeral port). Binds all interfaces by default.
const transport = new AxudpTransport("127.0.0.1", 8093, { localPort: 8190 });
const stack = new Ax25Stack(transport);
await stack.start();
const session = await stack.connect({ from: "M0LTE-2", to: "GB7CIP" });
```

AXUDP is **not** KISS — there's no SLIP framing, command byte, or CSMA. A datagram's payload *is* the AX.25 frame body (the KISS-form octets the listener produces) followed by the **2-octet AX.25 FCS** (CRC-16/X.25, low byte first). **The FCS is unconditional — there is no FCS-less mode.** Every real AXIP/AXUDP implementation mandates it (RFC 1226 + ax25ipd + BPQAXIP + XRouter + JNOS), so `AxudpTransport` always appends it on send and strips + validates it on receive (dropping any datagram with a bad FCS, exactly as a real peer does). Stripping is mandatory not cosmetic: the AX.25 parser rejects an S-frame (RR/RNR/REJ ack) carrying a trailing FCS tail. AXUDP is point-to-point — every outbound frame goes to the one configured remote (a frame for a third station is still sent there; the peer's AX.25 layer ignores it by address), the same as pointing a serial KISS link at one modem.

## Compatibility profiles & axping

The wire parser is spec-compliant by default with **named, individually-toggleable leniency flags** — the same `Ax25ParseOptions` discipline as the C# reference, kept in lock-step by a CI parity guard (`scripts/parity-check.mjs`). Presets bundle the flags: `LENIENT_PARSE` (the default — accepts every documented real-world quirk: all-space callsign slots from BPQ ID beacons, trailing bytes on supervisory frames, AX.25 v1.x connect frames lacking the v2 command bits), `STRICT_PARSE` (exactly AX.25 v2.2, rejects the rest at decode), and the per-neighbour presets `BPQ_PARSE` / `XROUTER_PARSE` / `DIREWOLF_PARSE`.

A listener takes its profile via `parseOptions` — a frame the options reject is dropped before tracing or dispatch, exactly as if it had failed CRC — and `quirks` selects the SDL session-quirk set for new sessions (`defaultSessionQuirks` = spec-correct; `strictlyFaithfulSessionQuirks` runs the published figures defects-and-all, for conformance study only):

```ts
const listener = new Ax25Listener(transport, {
  myCall: "M0LTE-1",
  parseOptions: STRICT_PARSE, // this port talks to a clean v2.2 peer only
});
```

**axping** — connectionless AX.25 TEST (§4.3.4.2) — works both ways with no configuration: an inbound TEST command is answered automatically with an echoing TEST response (never disturbing any session), and `sendTest` probes a remote station; correlate the echo via `onFrameTraced` to measure round-trip time:

```ts
listener.onFrameTraced(({ frame, direction }) => {
  if (direction === "rx" && classify(frame) === "TEST") {
    console.log("echo received — peer is alive");
  }
});
await listener.sendTest(Callsign.parse("GB7CIP"), new TextEncoder().encode("ping 1"));
```

A peer that doesn't implement TEST simply never answers — a timeout, not an error.

## Scope — what's in, what's out

### In

- Frame codec for U/S/I frames in **both modulos**: SABM, SABME, UA, DISC, DM, UI, RR, RNR, REJ, SREJ, I. The extended (mod-128) 2-octet control field on I and S frames is wired — 7-bit N(S)/N(R) + mode-aware P/F (Fig 4.1b), with the receive path threading the session's negotiated modulo (v2.2 arc V1, parity with [`m0lte/packet.net#266`](https://github.com/m0lte/packet.net/pull/266)). U frames stay 1 octet in both modes.
- 7-octet callsign codec with SSID + C/H + E-bit handling.
- KISS framing (FEND/FESC/TFEND/TFESC, multi-port nibble).
- Web Serial transport for the browser; Node transports for KISS-over-TCP listeners (BPQ / Xrouter / direwolf / net-sim) and AXUDP / BPQAXIP-over-UDP peers (`AxudpTransport`, FCS-always).
- Table-driven session machine walking the SDL transitions from [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) — same architecture as the C# reference runtime in [`m0lte/packet.net`'s `Packet.Ax25`](https://github.com/m0lte/packet.net/tree/main/src/Packet.Ax25/Session).
- SABM → UA → Connected, DISC → UA → Disconnected, I-frame TX/RX with V(s)/V(r)/V(a) bookkeeping, T1 retry capped at N2.
- **Inbound listener** — `Ax25Listener` accepts inbound SABM, fires `sessionAccepted`, caches per-peer sessions with LRU eviction, mirrors AX.25 §C.2 path reversal on responses.
- **figc4.7 subroutine walker** — `Enquiry_Response` / `Select_T1` / `Check_I_Frame_Acknowledged` etc. execute their SDL paths through the dispatcher. With LM-SEIZE granted immediately (contention-free single session), the figc4.4 delayed-ack RR flushes, so connected-mode data transfer **converges** (V(s) → V(a), windows reopen).
- **Loss recovery (REJ + SREJ)** — timeout-driven go-back-N (`Transmit_Enquiry` → `Invoke_Retransmission`) and single-frame selective reject over a **real SREJ frame on the wire**, with the SREJ recovery quirks (`ax25Spec40` window guard, `ax25Spec41` Karn SRT guard, `ax25Spec42` SREJ-targets-the-gap). The generative loss-recovery conformance suite drives single-drop and bidirectional-burst loss across both modes and asserts convergence (windows empty + complete in-order delivery).
- **XID / MDL parameter negotiation** — the management-data-link machine (figc5.1/figc5.2) runs the XID exchange after a v2.2 connect; negotiated parameters land on the session context. mod-128 (SABME) establishment, windowed transfer, and loss recovery are wired end-to-end (interop-proven against Dire Wolf).
- **Connectionless TEST / axping (§4.3.4.2)** — inbound TEST commands answered automatically with the echoing response (F mirrors P, never touching a session); `sendTest()` probes a remote. Parity with the C# listener (packet.net#348).
- **Compatibility profiles** — `Ax25ParseOptions` named flags (`allowEmptyCallsignBase`, `allowInfoOnSupervisoryFrames`, `allowCommandFrameAsResponse`) with `STRICT_PARSE` / `LENIENT_PARSE` / `BPQ_PARSE` / `XROUTER_PARSE` / `DIREWOLF_PARSE` presets, accepted per-listener (`parseOptions`) alongside per-listener session `quirks`. Kept in lock-step with the C# reference by the CI parity drift guard (`scripts/parity-check.mjs`).
- **Carrier-sense CSMA** — an optional, radio-agnostic `carrierSense` source on the listener (a `CarrierSense` with `channelBusy(): boolean | null`) the stack consults before every keyup: while it reports the channel busy the transmission is held (slot-time wait-for-clear, bounded, fail-open on unknown/timeout), keying up once it clears — so the AX.25 engine itself defers a keyup while another station is on the air. Omit it (the default) for the always-clear degenerate gate — byte-for-byte the prior fire-and-forget path. Any consumer that can observe channel occupancy (a hardware DCD line, a squelch/RSSI reading, a KISS DCD extension) supplies one; no radio specifics leak into the engine. Parity with the C# `ICarrierSense` / `Ax25ListenerOptions.CarrierSense` seam (packet.net OQ-012).
- **NET/ROM read-only "node aware"** — `NetRomService` taps `Ax25Listener`'s pre-address-filter frame trace to hear NODES routing broadcasts (UI, PID 0xCF, dest `NODES`), parses them (`parseNodesBroadcast`), and maintains a `NetRomRoutingTable` (multiplicative per-hop quality decay, ≤ 3 routes/destination best-first, OBSINIT/obsolescence sweep, trivial-loop guard, MINQUAL floor, table caps) surfaced as an immutable snapshot. Strictly read-only — **no TX, no L4 circuits, no NODES origination** — and hand-written, not SDL-derived (NET/ROM has no SDL figures; BPQ is the de-facto reference, an interop target, not truth). Divergences are named `NetRomParseOptions` flags with `NETROM_PARSE_STRICT` / `Lenient` / `Bpq` / `Xrouter` presets. Parity with [`m0lte/packet.net`'s `Packet.NetRom`](https://github.com/m0lte/packet.net/tree/main/src/Packet.NetRom) ([packet.net#303](https://github.com/m0lte/packet.net/pull/303)). See "Hearing NET/ROM NODES broadcasts" below.

### Out (deliberate — planned for later)

| Feature | Today | Tracked for |
| --- | --- | --- |
| `via` digipeater paths on *outbound* connects | `stack.connect({ via: [...] })` throws. (Inbound digipeater chains ARE handled — the listener mirrors AX.25 §C.2 path reversal on responses.) | post-v1 |
| AGW client / server | Not implemented (the [`Packet.Agw`](https://github.com/m0lte/packet.net/tree/main/src/Packet.Agw) .NET package has the working reference impl) | post-v1 |
| Audio modem transport (browser-side AFSK) | Not implemented | post-v1 |
| NET/ROM L3 datagram *forwarding* (transit-node relay) | Endpoint roles only (originate + terminate circuits); a transit node relaying third-party circuits is out of scope here as the equivalent was Phase-9 work on the C# side | post-v1 |
| Listener live parameter reseed | C#'s `UpdateSessionParameters` hot-reconfig — browser consumers reconstruct the listener instead. A reviewed exception in the parity guard. | if a TS host needs it |

(Stale rows removed 2026-06-10 — mod-128 negotiation, FRMR handling, k>1 windowing, and XID/MDL negotiation all shipped during the v2.2 arc; the "In" list above is current.)

## Hearing NET/ROM NODES broadcasts

`NetRomService` makes a node NET/ROM-*aware*: it taps `Ax25Listener`'s frame trace (which fires for every inbound frame **before** address filtering, so NODES broadcasts addressed to the literal callsign `NODES` are heard even though they aren't addressed to you), parses them, and builds a routing table. It is **read-only** — it never transmits, never opens a circuit, never originates a NODES broadcast, and can't disturb a live session.

```ts
import {
  Ax25Listener,
  Callsign,
  NetRomService,
} from "@packet-net/ax25";
import { TcpKissTransport } from "@packet-net/ax25/tcp-transport";

const transport = new TcpKissTransport("127.0.0.1", 8100, { kissPort: 0 });
const listener = new Ax25Listener(transport, { myCall: "M0LTE-1" });

const netrom = new NetRomService(); // enabled by default; read-only
netrom.attachPort("vhf", Callsign.parse("M0LTE-1"), listener);

await listener.start();

// Age routes out on the canonical hourly NODES interval (the library carries no
// ambient timer — you drive the obsolescence sweep):
setInterval(() => netrom.sweep(), 3600_000);

// Read the learned topology at any time — the analogue of a node's `NODES` cmd:
const snap = netrom.snapshot();
for (const n of snap.neighbours) {
  console.log(`neighbour ${n.alias || n.neighbour} on ${n.portId} q${n.pathQuality}`);
}
for (const d of snap.destinations) {
  const best = d.bestRoute;
  console.log(`${d.alias || d.destination}: via ${best?.neighbour} q${best?.quality}`);
}
```

Worked example at [`examples/netrom-aware.ts`](examples/netrom-aware.ts). Divergences from the canonical wire format are named `NetRomParseOptions` flags (`NETROM_PARSE_STRICT` / `NETROM_PARSE_LENIENT` / `NETROM_PARSE_BPQ` / `NETROM_PARSE_XROUTER`), passed via `new NetRomService({ parse, routing })`; the default ingest is lenient.

Beyond the read-only ingest, the module now also **originates** NODES (`NetRomOriginator`, the opt-in TX half) and routes **`connect <alias>`** end-to-end (`NetRomConnector`): given a destination alias or callsign it resolves the best route, opens a CONNECTED-mode AX.25 interlink (PID 0xCF) to the best neighbour, runs an L4 `NetRomCircuit` over it, and hands back a duplex `NetRomConnection` (`onData` / `write` / `onClosed` / `completion`) — reaching a node you have no direct RF path to, by name. Both are opt-in (`{ enabled: true }`) and embedder-driven (drive the originator's re-broadcast and the connector's circuit retransmits from your own `setInterval` — the library owns no ambient timers). L3 datagram *forwarding* (relaying a circuit a transit node is not an endpoint of) remains out of scope (the C# side's Phase-9 body too).

## Browser compatibility

Web Serial is supported in Chromium browsers (Chrome / Edge / Opera / Brave) on desktop OSes. Firefox and Safari don't expose it. The user must grant permission per port via `navigator.serial.requestPort()` from a user-gesture handler (button click, etc.).

For non-browser environments (Node.js / Bun / Deno) use the `TcpKissTransport` subpath or implement your own transport.

## Source layout

```
src/
├── address.ts                 Ax25Address record + codec
├── callsign.ts                Callsign type
├── frame.ts                   Ax25Frame, factories, encode/decode, classify
├── kiss.ts                    KISS framing
├── fcs.ts                     CRC-16/X.25 frame-check sequence (AXUDP wire form)
├── transport.ts               Ax25Transport interface
├── webserial-transport.ts     KISS over Web Serial
├── tcp-transport.ts           KISS over TCP (Node-only)
├── axudp-transport.ts         AX.25 over UDP / BPQAXIP (Node-only, FCS-always)
├── session.ts                 Public Ax25Stack / Ax25Session — outbound facade
├── listener.ts                Ax25Listener — inbound-accepting node coordinator
├── netrom/                    NET/ROM "node aware" slice (ingest + TX + L4 connect)
│   ├── nodes-broadcast.ts        NODES wire codec + NetRomParseOptions presets
│   ├── callsign.ts               shifted-callsign + alias field decoders
│   ├── quality.ts                multiplicative per-hop quality decay
│   ├── routing-table.ts          NetRomRoutingTable + model + resolveDestination
│   ├── service.ts                NetRomService — the frame-trace tap + snapshot API
│   ├── originator.ts             NetRomOriginator — the opt-in NODES TX half
│   ├── circuit.ts                NetRomCircuit + CircuitManager — the L4 transport
│   ├── connector.ts              NetRomConnector — connect <alias> → interlink + circuit
│   └── connection.ts             NetRomConnection — duplex stream over an L4 circuit
└── sdl/                       Table-walking session engine
    ├── events.ts                  Ax25Event variants
    ├── timer-scheduler.ts         T1/T2/T3 arming
    ├── session-context.ts         Mutable per-session state
    ├── guard-evaluator.ts         Parses `"a and not b or c"` guards
    ├── session-bindings.ts        Predicate name → closure
    ├── action-dispatcher.ts       Switch over ~140 SDL action verbs
    ├── subroutine-registry.ts     figc4.7 subroutine table walker
    ├── sdl-loop-executor.ts       shared SDL loop expansion (driver + walker)
    └── session-driver.ts          PostEvent → find transition → execute → advance
```

## Provenance

Extracted from `m0lte/packet.net` on 2026-05-17 (history preserved via `git filter-repo --path web/ax25/ --path-rename web/ax25/:` — 13 commits spanning the library's full life). Before the split, the library lived at `web/ax25/` in that monorepo.

The cross-runtime integration test (`tests/integration/linbpq-via-netsim.test.ts`) runs in [`m0lte/packet.net`'s `interop.yml`](https://github.com/m0lte/packet.net/blob/main/.github/workflows/interop.yml) — that workflow clones this repo and dials the docker stack standing up there (LinBPQ + Xrouter + rax25 + netsim). The docker stack lives in `m0lte/packet.net` and isn't replicated here.

## Sibling repos

| Repo | What it is |
| --- | --- |
| **`m0lte/ax25-ts`** *(here)* | `@packet-net/ax25` browser TS library |
| [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl) | SDL transcriptions + codegen — publishes the [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) npm package this library consumes |
| [`m0lte/packet.net`](https://github.com/m0lte/packet.net) | .NET libraries + node host + docker interop matrix (which exercises this library's integration suite) |
| [`m0lte/packet-term-tui`](https://github.com/m0lte/packet-term-tui) | C# Terminal.Gui TUI (the .NET counterpart of [`packet-term-web`](https://github.com/m0lte/packet-term-web)) |
| [`m0lte/packet-term-web`](https://github.com/m0lte/packet-term-web) | Browser TNC2 emulator at https://packet-term.m0lte.uk — consumes this library |

## License

[MIT](LICENSE) — copyright Tom Fanning and Packet.NET contributors.
