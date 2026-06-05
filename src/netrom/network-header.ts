import type { Callsign } from "../callsign.js";
import {
  NETROM_SHIFTED_LENGTH,
  tryReadShifted,
  writeShifted,
} from "./callsign.js";

/**
 * The NET/ROM L3 network header — 15 octets prepended to every inter-node
 * datagram carried over a connected-mode AX.25 interlink (PID 0xCF). It names
 * the end-to-end origin and destination *nodes* (not the hop-by-hop AX.25
 * addresses, which are the interlink's own) and carries the hop-limit
 * time-to-live a forwarding node decrements.
 *
 * Layout (canonical NET/ROM appendix), 15 octets:
 * ```
 *   [7] origin node callsign       (AX.25 shifted form)
 *   [7] destination node callsign  (AX.25 shifted form)
 *   [1] time-to-live               (hop limit; decremented per node; 0 → discard)
 * ```
 *
 * The 5 octets immediately after this header are the L4
 * {@link NetRomTransportHeader}; the bytes after that are the transport payload.
 * A full L3 datagram is {@link NetRomPacket}.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomNetworkHeader` on the C# side. Modelled as a
 * plain interface + free functions (the project's wire-codec idiom — see
 * `transport-header.ts`), not a class.
 */

/** Octets this header occupies on the wire (7 origin + 7 destination + 1 TTL). */
export const NETWORK_HEADER_ENCODED_LENGTH =
  NETROM_SHIFTED_LENGTH + NETROM_SHIFTED_LENGTH + 1; // 15

/**
 * The canonical default initial time-to-live (BPQ's `L3TIMETOLIVE` default; the
 * Linux `network_ttl_initialiser` default is also in this band). Operator-tunable
 * via {@link NetRomCircuitOptions}.
 */
export const DEFAULT_TIME_TO_LIVE = 25;

/**
 * One NET/ROM L3 network header (origin/destination nodes + TTL). Mirrors
 * `Packet.NetRom.Wire.NetRomNetworkHeader` on the C# side.
 */
export interface NetRomNetworkHeader {
  /** The end-to-end origin node. */
  readonly origin: Callsign;
  /** The end-to-end destination node. */
  readonly destination: Callsign;
  /** Hop-limit counter; a forwarding node decrements it and discards the
   *  datagram at 0. */
  readonly timeToLive: number;
}

/**
 * Return a copy of `header` with the time-to-live decremented by one. The caller
 * checks the result is > 0 before forwarding (a header that arrives at TTL 1
 * decrements to 0 and must not be forwarded). Never underflows: a TTL of 0 stays
 * 0.
 *
 * Mirrors `NetRomNetworkHeader.Decremented` on the C# side.
 */
export function decrementedNetworkHeader(
  header: NetRomNetworkHeader,
): NetRomNetworkHeader {
  return {
    ...header,
    timeToLive: header.timeToLive === 0 ? 0 : header.timeToLive - 1,
  };
}

/**
 * Encode `header` into `dest` at `offset` (which must have at least
 * {@link NETWORK_HEADER_ENCODED_LENGTH} octets of room).
 *
 * Mirrors `NetRomNetworkHeader.Write` on the C# side.
 *
 * @throws If `dest` does not have room for the 15-octet header at `offset`.
 */
export function writeNetworkHeader(
  header: NetRomNetworkHeader,
  dest: Uint8Array,
  offset = 0,
): void {
  if (dest.length < offset + NETWORK_HEADER_ENCODED_LENGTH) {
    throw new Error(
      `network header needs ${NETWORK_HEADER_ENCODED_LENGTH} bytes of room (got ${dest.length - offset})`,
    );
  }
  writeShifted(header.origin, dest, offset);
  writeShifted(header.destination, dest, offset + NETROM_SHIFTED_LENGTH);
  dest[offset + NETROM_SHIFTED_LENGTH * 2] = header.timeToLive & 0xff;
}

/**
 * Allocate and return `header`'s 15-octet encoding.
 *
 * Mirrors `NetRomNetworkHeader.ToBytes` on the C# side.
 */
export function encodeNetworkHeader(header: NetRomNetworkHeader): Uint8Array {
  const buf = new Uint8Array(NETWORK_HEADER_ENCODED_LENGTH);
  writeNetworkHeader(header, buf, 0);
  return buf;
}

/**
 * Try to decode a 15-octet network header from `source` at `offset`. Returns
 * `null` (never throws) if the span is too short or either callsign field fails
 * to decode.
 *
 * Mirrors `NetRomNetworkHeader.TryParse` on the C# side.
 */
export function tryParseNetworkHeader(
  source: Uint8Array,
  offset = 0,
): NetRomNetworkHeader | null {
  if (source.length < offset + NETWORK_HEADER_ENCODED_LENGTH) {
    return null;
  }
  const origin = tryReadShifted(source, offset);
  if (origin === null) {
    return null;
  }
  const destination = tryReadShifted(source, offset + NETROM_SHIFTED_LENGTH);
  if (destination === null) {
    return null;
  }
  return {
    origin,
    destination,
    timeToLive: source[offset + NETROM_SHIFTED_LENGTH * 2]!,
  };
}
