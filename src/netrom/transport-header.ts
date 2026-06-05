/**
 * The NET/ROM L4 transport header — 5 octets immediately following the L3
 * network header in an inter-node datagram. It identifies the circuit, carries
 * the sliding-window sequence numbers, and names the message type + flow-control
 * flags.
 *
 * Layout (canonical NET/ROM appendix), 5 octets:
 * ```
 *   [1] circuit index      (slot in the far end's circuit table — "your" index)
 *   [1] circuit ID         (serial qualifying the index — "your" id)
 *   [1] TX sequence number (this message's send-sequence; 8-bit, mod 256)
 *   [1] RX sequence number (the next send-sequence we expect; the piggybacked ack)
 *   [1] opcode & flags      (low nibble = NetRomOpcode; high bits = NetRomTransportFlags)
 * ```
 *
 * The index/ID pair are *the receiver's* identifiers (the values it gave us in
 * its Connect (Acknowledge)) so it can demultiplex the datagram to the right
 * circuit without parsing the callsigns — which is why on a Connect Request the
 * index/ID name the *sender's* own circuit (the receiver learns them and echoes
 * them back).
 *
 * Several fields are overloaded per opcode (e.g. Connect Request carries the
 * proposed window size in the TX-sequence slot, Connect Acknowledge the accepted
 * window). This type models the raw 5 octets faithfully; the per-opcode meaning
 * is applied by the circuit layer.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomTransportHeader` + `NetRomOpcode` on the C#
 * side. The opcode/flags use the project's `as const` value-union idiom (see
 * `KISS_CMD` in `../kiss.ts`) rather than a TS `enum` — a compile-time-typed
 * closed set of the byte values, matching the C# `enum : byte` semantics without
 * introducing the project's first `enum`.
 */

/**
 * The six NET/ROM L4 (transport) message types — the low nibble of the transport
 * header's opcode-and-flags byte. The high bits of that byte are the independent
 * {@link NetRomTransportFlags} (choke / NAK / more-follows), so always mask with
 * {@link OPCODE_MASK} before comparing.
 *
 * Values are the canonical NET/ROM appendix opcodes (the "Structure of Inter-Node
 * HDLC Frames" transport table). They are the de-facto wire numbers every
 * implementation (BPQ, XRouter, the Linux `netrom` family) agrees on — unlike the
 * routing quality maths, the opcode set does not diverge.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomOpcode` on the C# side.
 */
export const NetRomOpcode = {
  /** Connect Request (0x01): open a circuit. Info carries the originating-user +
   *  originating-node callsigns; the header proposes a window size. */
  ConnectRequest: 0x01,
  /** Connect Acknowledge (0x02): accept (or, with the choke/bit-7 flag set,
   *  refuse) a circuit. Carries the accepted window size (≤ proposed). */
  ConnectAcknowledge: 0x02,
  /** Disconnect Request (0x03): tear a circuit down. */
  DisconnectRequest: 0x03,
  /** Disconnect Acknowledge (0x04): confirm a disconnect. */
  DisconnectAcknowledge: 0x04,
  /** Information (0x05): up to 236 bytes of user data, piggybacking an ack via
   *  the RX-sequence field; the more-follows flag marks a fragment of a larger
   *  logical frame. */
  Information: 0x05,
  /** Information Acknowledge (0x06): a standalone ack (RX sequence), and the
   *  carrier of the choke / NAK flow-control flags. */
  InformationAcknowledge: 0x06,
} as const;

/**
 * The opcode nibble carried in a transport header. Any 4-bit value parses (an
 * unknown opcode is surfaced as its raw number for the circuit layer to reject),
 * so this is the *known* set, widened to `number` where an arbitrary nibble can
 * appear — see {@link NetRomTransportHeader.opcode}.
 */
export type NetRomOpcode = (typeof NetRomOpcode)[keyof typeof NetRomOpcode];

/**
 * The independent flag bits packed into the high bits of the transport header's
 * opcode-and-flags byte, above the {@link NetRomOpcode} nibble.
 *
 * On a Connect Acknowledge, the choke bit (bit 7) is overloaded to mean
 * *refused* (the canonical "connection refused" encoding), since a refused
 * circuit has no flow to choke.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomTransportFlags` ([Flags] enum) on the C#
 * side. Because the high nibble can carry any combination of the three bits, the
 * stored {@link NetRomTransportHeader.flags} is a plain `number` (the masked high
 * bits); these consts name the individual bits for OR-ing and testing.
 */
export const NetRomTransportFlags = {
  /** No flags. */
  None: 0x00,
  /** More-follows (bit 5): this Information message is a non-final fragment of a
   *  logical frame larger than one 236-byte payload. */
  MoreFollows: 0x20,
  /** NAK (bit 6): request selective retransmission of the frame named by the
   *  RX-sequence field. */
  Nak: 0x40,
  /** Choke (bit 7): tell the far end to stop sending Information until further
   *  notice — the flow-control backpressure signal. On a Connect Acknowledge this
   *  same bit instead means the circuit was refused. */
  Choke: 0x80,
} as const;

/** One named transport flag bit. The stored flags field is the OR of these. */
export type NetRomTransportFlag =
  (typeof NetRomTransportFlags)[keyof typeof NetRomTransportFlags];

/** Octets this header occupies on the wire. */
export const TRANSPORT_HEADER_ENCODED_LENGTH = 5;

/** The low nibble of the opcode-and-flags byte (the message type). */
export const OPCODE_MASK = 0x0f;

/** The high bits of the opcode-and-flags byte (the flow-control flags). */
export const FLAGS_MASK = 0xf0;

/**
 * One NET/ROM L4 transport header, modelling the raw 5 octets faithfully. The
 * per-opcode reinterpretation of the sequence/window slots is the circuit
 * layer's job.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomTransportHeader` on the C# side.
 */
export interface NetRomTransportHeader {
  /** The far end's circuit-table slot ("your index"). */
  readonly circuitIndex: number;
  /** The serial number qualifying {@link circuitIndex} ("your id"). */
  readonly circuitId: number;
  /** This message's send sequence (8-bit, wraps mod 256). */
  readonly txSequence: number;
  /** The next send sequence we expect from the peer — the piggybacked ack. */
  readonly rxSequence: number;
  /**
   * The message type (low nibble of the opcode-and-flags byte). One of the
   * {@link NetRomOpcode} values for a known message, or an arbitrary 0..15 nibble
   * for an unknown opcode (parsing is total — the circuit layer rejects unknowns).
   */
  readonly opcode: NetRomOpcode | number;
  /**
   * The flow-control flags — the masked high nibble (`opcodeAndFlags & FLAGS_MASK`),
   * an OR of the {@link NetRomTransportFlags} bits. Test with the `choke` / `nak`
   * / `moreFollows` helpers below rather than comparing the whole byte.
   */
  readonly flags: number;
}

/** True if the choke flag (bit 7) is set. On a Connect Acknowledge this instead
 *  signals refusal — see {@link NetRomTransportFlags.Choke}. */
export function transportHeaderChoke(header: NetRomTransportHeader): boolean {
  return (header.flags & NetRomTransportFlags.Choke) !== 0;
}

/** True if the NAK flag (bit 6) is set (selective-retransmit request). */
export function transportHeaderNak(header: NetRomTransportHeader): boolean {
  return (header.flags & NetRomTransportFlags.Nak) !== 0;
}

/** True if the more-follows flag (bit 5) is set (a non-final fragment). */
export function transportHeaderMoreFollows(
  header: NetRomTransportHeader,
): boolean {
  return (header.flags & NetRomTransportFlags.MoreFollows) !== 0;
}

/**
 * The raw opcode-and-flags byte (opcode nibble OR-ed with the flag bits) — the
 * fifth octet of the encoded header.
 */
export function transportHeaderOpcodeAndFlags(
  header: NetRomTransportHeader,
): number {
  return (header.opcode & OPCODE_MASK) | (header.flags & FLAGS_MASK);
}

/**
 * Encode `header` into `dest` at `offset` (which must have at least
 * {@link TRANSPORT_HEADER_ENCODED_LENGTH} octets of room).
 *
 * Mirrors `NetRomTransportHeader.Write` on the C# side.
 *
 * @throws If `dest` does not have room for the 5-octet header at `offset`.
 */
export function writeTransportHeader(
  header: NetRomTransportHeader,
  dest: Uint8Array,
  offset = 0,
): void {
  if (dest.length < offset + TRANSPORT_HEADER_ENCODED_LENGTH) {
    throw new Error(
      `transport header needs ${TRANSPORT_HEADER_ENCODED_LENGTH} bytes of room (got ${dest.length - offset})`,
    );
  }
  dest[offset] = header.circuitIndex & 0xff;
  dest[offset + 1] = header.circuitId & 0xff;
  dest[offset + 2] = header.txSequence & 0xff;
  dest[offset + 3] = header.rxSequence & 0xff;
  dest[offset + 4] = transportHeaderOpcodeAndFlags(header) & 0xff;
}

/**
 * Allocate and return `header`'s 5-octet encoding.
 *
 * Mirrors `NetRomTransportHeader.ToBytes` on the C# side.
 */
export function encodeTransportHeader(
  header: NetRomTransportHeader,
): Uint8Array {
  const buf = new Uint8Array(TRANSPORT_HEADER_ENCODED_LENGTH);
  writeTransportHeader(header, buf, 0);
  return buf;
}

/**
 * Try to decode a 5-octet transport header from `source` at `offset`. Returns
 * `null` only if the span is too short — any opcode-nibble value parses (an
 * unknown opcode is surfaced as its raw number for the circuit layer to reject).
 *
 * Mirrors `NetRomTransportHeader.TryParse` on the C# side.
 */
export function tryParseTransportHeader(
  source: Uint8Array,
  offset = 0,
): NetRomTransportHeader | null {
  if (source.length < offset + TRANSPORT_HEADER_ENCODED_LENGTH) {
    return null;
  }
  const opByte = source[offset + 4]!;
  return {
    circuitIndex: source[offset]!,
    circuitId: source[offset + 1]!,
    txSequence: source[offset + 2]!,
    rxSequence: source[offset + 3]!,
    opcode: opByte & OPCODE_MASK,
    flags: opByte & FLAGS_MASK,
  };
}
