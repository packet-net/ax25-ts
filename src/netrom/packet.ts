import {
  NETWORK_HEADER_ENCODED_LENGTH,
  type NetRomNetworkHeader,
  tryParseNetworkHeader,
  writeNetworkHeader,
} from "./network-header.js";
import {
  type NetRomTransportHeader,
  TRANSPORT_HEADER_ENCODED_LENGTH,
  tryParseTransportHeader,
  writeTransportHeader,
} from "./transport-header.js";

/**
 * A complete NET/ROM L3 datagram as carried in one connected-mode AX.25
 * interlink I-frame (PID 0xCF): a 15-octet {@link NetRomNetworkHeader}, a 5-octet
 * {@link NetRomTransportHeader}, and the transport payload (0..236 octets — empty
 * for the control opcodes; user data for Information).
 *
 * This is the unit a node sends/receives/forwards: the AX.25 layer delivers the
 * I-frame's information field, this parses it into header + header + payload, and
 * the circuit layer acts on it. The repo's own BPQ corpus observed PID-0xCF
 * I-frames "always exactly 20 B" — that is exactly this with an empty payload
 * (15 + 5).
 *
 * Parsing is total: arbitrary bytes never throw, they return `null`.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomPacket` on the C# side.
 */

/**
 * Maximum transport payload (user data) one datagram carries — the canonical
 * 256-octet NET/ROM frame minus the 20 octets of L3+L4 header. A larger logical
 * frame is fragmented across several Information datagrams via the more-follows
 * flag.
 */
export const MAX_PAYLOAD = 236;

/** Octets of fixed header (network + transport) every datagram carries. */
export const PACKET_HEADER_LENGTH =
  NETWORK_HEADER_ENCODED_LENGTH + TRANSPORT_HEADER_ENCODED_LENGTH; // 20

/**
 * One NET/ROM L3 datagram. Mirrors `Packet.NetRom.Wire.NetRomPacket` on the C#
 * side.
 */
export interface NetRomPacket {
  /** The L3 network header (origin/destination nodes + TTL). */
  readonly network: NetRomNetworkHeader;
  /** The L4 transport header (circuit + sequencing + opcode/flags). */
  readonly transport: NetRomTransportHeader;
  /** The transport payload (0..236 octets). Empty for control opcodes. */
  readonly payload: Uint8Array;
}

/**
 * Encode `packet` into the bytes to hand to the AX.25 interlink (the I-frame
 * information field, sent with PID 0xCF).
 *
 * Mirrors `NetRomPacket.ToBytes` on the C# side.
 */
export function encodeNetRomPacket(packet: NetRomPacket): Uint8Array {
  const payload = packet.payload ?? new Uint8Array(0);
  const buf = new Uint8Array(PACKET_HEADER_LENGTH + payload.length);
  writeNetworkHeader(packet.network, buf, 0);
  writeTransportHeader(packet.transport, buf, NETWORK_HEADER_ENCODED_LENGTH);
  buf.set(payload, PACKET_HEADER_LENGTH);
  return buf;
}

/**
 * Try to decode a NET/ROM datagram from an interlink I-frame's information field.
 * Returns `null` (never throws) if the field is shorter than the 20-octet fixed
 * header or either header fails to decode. A payload longer than
 * {@link MAX_PAYLOAD} still parses (the circuit layer decides what to do with an
 * over-long fragment — being total here keeps a malformed peer from sinking the
 * parser).
 *
 * Mirrors `NetRomPacket.TryParse` on the C# side.
 */
export function tryParseNetRomPacket(info: Uint8Array): NetRomPacket | null {
  if (info.length < PACKET_HEADER_LENGTH) {
    return null;
  }
  const network = tryParseNetworkHeader(info, 0);
  if (network === null) {
    return null;
  }
  const transport = tryParseTransportHeader(info, NETWORK_HEADER_ENCODED_LENGTH);
  if (transport === null) {
    return null;
  }
  return {
    network,
    transport,
    payload: info.slice(PACKET_HEADER_LENGTH),
  };
}
