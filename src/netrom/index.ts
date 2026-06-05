/**
 * NET/ROM read-only "node aware" slice — hear NODES routing broadcasts, build a
 * routing table, surface it. Pure consumer of the {@link Ax25Listener} frame-trace
 * tap; **transmits nothing** (no TX, no L4 circuits, no NODES origination).
 *
 * Parity with the C# `Packet.NetRom` library + `NetRomService` node-host wiring
 * (m0lte/packet.net PR #303). NET/ROM has no SDL figures and no single normative
 * standard — BPQ is the de-facto reference, an interop target, *not* reference
 * truth — so this is hand-written, with every divergence a named
 * {@link NetRomParseOptions} flag (Strict / Lenient / Bpq / Xrouter presets),
 * the same "spec-compliant by default, pragmatism is a named flag" discipline
 * the AX.25 side uses.
 */
export {
  // wire constants
  NODES_SIGNATURE,
  NODES_DESTINATION,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_ENTRY_ENCODED_LENGTH,
  // parse options + presets
  type NetRomParseOptions,
  NETROM_PARSE_STRICT,
  NETROM_PARSE_LENIENT,
  NETROM_PARSE_BPQ,
  NETROM_PARSE_XROUTER,
  // parsed wire types + parser
  type NodesRoutingEntry,
  type NodesBroadcast,
  parseNodesBroadcast,
} from "./nodes-broadcast.js";

export {
  // callsign-field codecs (decode + encode)
  NETROM_SHIFTED_LENGTH,
  NETROM_ALIAS_LENGTH,
  tryReadShifted,
  readAlias,
  writeShifted,
  writeAlias,
} from "./callsign.js";

export {
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
} from "./transport-header.js";

export {
  // L4 Connect Request info field (15-octet) builder + parser
  type ConnectRequestInfo,
  CONNECT_REQUEST_INFO_LENGTH,
  buildConnectRequestInfo,
  tryParseConnectRequestInfo,
} from "./connect-request-info.js";

export {
  // NODES-broadcast origination (L3 builder — counterpart to parseNodesBroadcast)
  type NodesBroadcastEntry,
  buildNodesBroadcast,
} from "./nodes-broadcast-builder.js";

export {
  // quality arithmetic
  NETROM_QUALITY_MAX,
  NETROM_QUALITY_MIN,
  combineQuality,
} from "./quality.js";

export {
  // routing model + table
  type NetRomRoutingOptions,
  NETROM_ROUTING_DEFAULTS,
  type NetRomRoute,
  type NetRomDestination,
  type NetRomNeighbour,
  type NetRomRoutingSnapshot,
  EMPTY_NETROM_SNAPSHOT,
  NetRomRoutingTable,
} from "./routing-table.js";

export {
  // the node-level service (the read-only tap + public API)
  type NetRomServiceOptions,
  NetRomService,
} from "./service.js";
