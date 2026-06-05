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
 *   ✓ Node transports — KISS-over-TCP (`@packet-net/ax25/tcp-transport`) +
 *     AXUDP / BPQAXIP-over-UDP (`@packet-net/ax25/axudp-transport`, FCS-always).
 *     AGW + browser-side AFSK transports are not implemented (Web Serial is the
 *     only browser transport)
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
  type Ax25ParseOptions,
  type FrameFactoryOpts,
  type FrameKind,
  LENIENT_PARSE,
  MAX_DIGIPEATERS,
  PID_NET_ROM,
  PID_NO_LAYER_3,
  PID_SEGMENTED,
  STRICT_PARSE,
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
export { classifyFrame } from "./sdl/frame-classifier.js";
export {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "./sdl/session-quirks.js";
export type { DataLinkSignal, MdlSignal } from "./sdl/action-dispatcher.js";
export { Ax25ManagementDataLink } from "./sdl/management-data-link.js";
export {
  type DataLinkDataIndication,
  SegmentationLayer,
} from "./sdl/segmentation-layer.js";
export {
  Reassembler,
  SEGMENT_COUNT_MASK,
  SEGMENT_FIRST_BIT,
  SEGMENT_MAX_SEGMENTS,
  segment,
} from "./sdl/segmenter.js";
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
export {
  // NET/ROM "node aware" slice (parity with packet.net's Packet.NetRom): hear
  // NODES broadcasts, build a routing table, surface a snapshot. The routing
  // table / service path is a pure read-only consumer of the Ax25Listener tap;
  // the wire codecs below additionally include the L4 / L3-origination *encoders*
  // (transport header, Connect Request info, NODES builder) that later TX slices
  // ride on.
  // wire
  NODES_SIGNATURE,
  NODES_DESTINATION,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_ENTRY_ENCODED_LENGTH,
  type NodesRoutingEntry,
  type NodesBroadcast,
  parseNodesBroadcast,
  // parse options + presets
  type NetRomParseOptions,
  NETROM_PARSE_STRICT,
  NETROM_PARSE_LENIENT,
  NETROM_PARSE_BPQ,
  NETROM_PARSE_XROUTER,
  // callsign-field codecs (decode + encode)
  NETROM_SHIFTED_LENGTH,
  NETROM_ALIAS_LENGTH,
  tryReadShifted,
  readAlias,
  writeShifted,
  writeAlias,
  // L4 transport header (5-octet) + opcode/flags closed sets
  NetRomOpcode,
  NetRomTransportFlags,
  type NetRomTransportFlag,
  type NetRomTransportHeader,
  TRANSPORT_HEADER_ENCODED_LENGTH,
  OPCODE_MASK,
  FLAGS_MASK,
  transportHeaderChoke,
  transportHeaderNak,
  transportHeaderMoreFollows,
  transportHeaderOpcodeAndFlags,
  writeTransportHeader,
  encodeTransportHeader,
  tryParseTransportHeader,
  // L4 Connect Request info field (15-octet) builder + parser
  type ConnectRequestInfo,
  CONNECT_REQUEST_INFO_LENGTH,
  buildConnectRequestInfo,
  tryParseConnectRequestInfo,
  // NODES-broadcast origination (L3 builder — counterpart to parseNodesBroadcast)
  type NodesBroadcastEntry,
  buildNodesBroadcast,
  // quality
  NETROM_QUALITY_MAX,
  NETROM_QUALITY_MIN,
  combineQuality,
  // routing model + table
  type NetRomRoutingOptions,
  NETROM_ROUTING_DEFAULTS,
  type NetRomRoute,
  type NetRomDestination,
  type NetRomNeighbour,
  type NetRomRoutingSnapshot,
  EMPTY_NETROM_SNAPSHOT,
  NetRomRoutingTable,
  // the node-level service (the read-only tap + public API)
  type NetRomServiceOptions,
  NetRomService,
} from "./netrom/index.js";
