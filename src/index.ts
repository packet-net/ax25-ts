/**
 * @packet-net/ax25 — browser-targeted TypeScript library for AX.25 v2.2
 * connected-mode sessions over Web Serial KISS modems.
 *
 * Quick start (see README for the long-form):
 *
 * ```ts
 * import {
 *   Ax25Stack,
 *   WebSerialKissTransport,
 *   Callsign,
 * } from "@packet-net/ax25";
 *
 * const port = await navigator.serial.requestPort();
 * const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
 * const stack = new Ax25Stack(transport);
 * await stack.start();
 * const session = await stack.connect({ from: "M0LTE-2", to: "GB7CIP" });
 * session.onData((chunk) => console.log(new TextDecoder().decode(chunk)));
 * await session.write(new TextEncoder().encode("hello\r"));
 * // ...
 * await session.disconnect();
 * await stack.stop();
 * ```
 *
 * Scope summary — what IS and ISN'T implemented:
 *
 *   ✓ Frame codec for SABM, DISC, UA, DM, UI, RR, RNR, REJ, I (mod-8)
 *   ✓ 7-octet callsign codec with SSID + C/H + E bit handling
 *   ✓ KISS framing (FEND/FESC escape, port nibble)
 *   ✓ Web Serial transport (Chrome / Edge / Opera on a desktop with the
 *     `chrome://flags/#enable-experimental-web-platform-features` setting,
 *     or unflagged in supported browsers)
 *   ✓ SABM → UA → Connected, DISC → UA → Disconnected
 *   ✓ I-frame TX/RX with V(s)/V(r)/V(a) bookkeeping, k=1 window
 *   ✓ T1 retry (default 3 s), capped at N2 (default 10)
 *   ✓ Session state machine walks the generated SDL tables in
 *     [`ax25sdl`](../../../ts-spec/) — same transitions as the C# runtime
 *     reads from `src/Packet.Ax25.Sdl/*.g.cs`
 *
 *   ◐ mod-128 (extended) — the 2-octet I/S control-field *codec* is wired
 *     (v2.2 arc V1; encode/parse 7-bit N(S)/N(R) + mode-aware P/F, receive
 *     path threads the session modulo); connected-mode *negotiation* of
 *     mod-128 from an inbound SABME is not yet done (lands with V4)
 *   ✓ T1 dynamic adjustment — figc4.7 `Select_T1` runs the SRT/T1V IIR
 *     (with the Karn-algorithm guard, ax25Spec41); `freezeT1V` pins T1V
 *     to a caller-supplied `t1Ms` when deterministic timing is wanted
 *   ✗ FRMR generation/handling
 *   ✗ Multi-frame TX windowing via the public API (`Ax25SessionOptions`
 *     exposes no `k`; the driver honours `ctx.k` and the conformance
 *     harness drives k>1, but `stack.connect` leaves it at the default 4)
 *   ✓ REJ + SREJ loss recovery — go-back-N (`Invoke_Retransmission`) and
 *     single-frame selective reject over a real SREJ frame on the wire,
 *     with the SREJ recovery quirks (ax25Spec40/41/42); see the
 *     loss-recovery conformance suite
 *   ✗ Full figc4.7 subroutine framework (the dispatcher inlines the
 *     subset the happy path needs; the rest route through the registry
 *     walker — Enquiry_Response / Select_T1 / Invoke_Retransmission /
 *     Transmit_Enquiry now have real bodies)
 *   ✗ Digipeater paths (`via` throws "not implemented")
 *   ✗ TCP/AGW/audio transports — Web Serial only
 *   ✓ Inbound connection acceptance via `Ax25Listener` (per-peer
 *     session cache, `sessionAccepted` / `frameTraced` events, LRU
 *     eviction). See README "Listening for inbound connections".
 */

export { Callsign } from "./callsign.js";
export {
  ADDRESS_ENCODED_LENGTH,
  type Ax25Address,
  readAddress,
  writeAddress,
} from "./address.js";
export {
  type Ax25Frame,
  type FrameFactoryOpts,
  type FrameKind,
  MAX_DIGIPEATERS,
  PID_NET_ROM,
  PID_NO_LAYER_3,
  classify,
  decodeFrame,
  disc,
  dm,
  encodeFrame,
  frmr,
  getNr,
  getNs,
  iFrame,
  isCommand,
  isExtendedControl,
  isResponse,
  pollFinal,
  requiredBytes,
  rej,
  rnr,
  rr,
  sabm,
  srej,
  ua,
  ui,
  xid,
} from "./frame.js";
export {
  FEND,
  FESC,
  KISS_CMD,
  type KissCommand,
  KissDecoder,
  type KissFrame,
  TFEND,
  TFESC,
  encodeKiss,
} from "./kiss.js";
export type { Ax25Transport } from "./transport.js";
export {
  WebSerialKissTransport,
  type WebSerialKissTransportOptions,
  type WebSerialLikePort,
} from "./webserial-transport.js";
export {
  Ax25Session,
  type Ax25SessionOptions,
  Ax25Stack,
} from "./session.js";
export {
  Ax25Listener,
  Ax25ListenerSession,
  type Ax25ListenerOptions,
  type Ax25FrameTracedEvent,
  type FrameDirection,
} from "./listener.js";
export type { Ax25Event } from "./sdl/events.js";
export {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "./sdl/session-quirks.js";
export type { DataLinkSignal, MdlSignal } from "./sdl/action-dispatcher.js";
export { Ax25ManagementDataLink } from "./sdl/management-data-link.js";
export {
  applyNegotiated,
  applyVersion20Defaults,
} from "./sdl/xid-negotiator.js";
export { sabme } from "./frame.js";
export {
  // header constants
  XID_FORMAT_IDENTIFIER,
  XID_GROUP_IDENTIFIER,
  XID_HEADER_LENGTH,
  // parameter identifiers
  PI_CLASSES_OF_PROCEDURES,
  PI_HDLC_OPTIONAL_FUNCTIONS,
  PI_I_FIELD_LENGTH_TX,
  PI_I_FIELD_LENGTH_RX,
  PI_WINDOW_SIZE_TX,
  PI_WINDOW_SIZE_RX,
  PI_ACK_TIMER,
  PI_RETRIES,
  // Classes of Procedures
  type ClassesOfProcedures,
  CLASSES_OF_PROCEDURES_HALF_DUPLEX,
  CLASSES_OF_PROCEDURES_FULL_DUPLEX,
  classesOfProceduresToOctets,
  classesOfProceduresFromOctets,
  // HDLC Optional Functions
  type RejectMode,
  type HdlcOptionalFunctions,
  HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
  hdlcOptionalFunctionsToOctets,
  hdlcOptionalFunctionsFromOctets,
  // parameter set
  type XidParameters,
  iFieldLengthRxOctets,
  octetsToBits,
  // parse options
  type XidParseOptions,
  XID_PARSE_STRICT,
  XID_PARSE_LENIENT,
  // codec
  type XidParseResult,
  encodeXid,
  tryParseXid,
  encodeUnsignedXid,
  decodeUnsignedXid,
} from "./xid.js";
