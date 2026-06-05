import type { Callsign } from "../callsign.js";
import {
  NETROM_ALIAS_LENGTH,
  NETROM_SHIFTED_LENGTH,
  writeAlias,
  writeShifted,
} from "./callsign.js";
import {
  NODES_ENTRY_ENCODED_LENGTH,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_SIGNATURE,
} from "./nodes-broadcast.js";

/**
 * Builds the information field(s) of one or more NET/ROM NODES routing
 * broadcasts — the L3-origination counterpart to {@link parseNodesBroadcast}.
 * The caller transmits each returned byte array as a UI frame (PID 0xCF, AX.25
 * destination the literal text callsign `NODES`).
 *
 * The wire format is the canonical one the parser already documents: a 0xFF
 * signature, the sender's 6-octet alias, then the destination entries packed
 * {@link NODES_MAX_ENTRIES_PER_FRAME} (11) per frame. A routing table with more
 * than 11 advertisable destinations is dumped across several frames, each a
 * self-contained broadcast (the receiver merges them by destination, so frame
 * boundaries don't matter).
 *
 * Construction stays strict (we never emit a frame that violates the canonical
 * format — the outbound path is always spec-faithful, per CLAUDE.md), even though
 * the parser tolerates real-world divergences inbound.
 *
 * Mirrors `Packet.NetRom.Wire.NodesBroadcastBuilder` on the C# side.
 */

/** Signature + 6-byte alias = 7 octets at the front of every NODES frame. */
const NODES_HEADER_LENGTH = 1 + NETROM_ALIAS_LENGTH;

/**
 * One destination entry to advertise: the destination node + its alias, the
 * best-neighbour we forward through, and the quality we advertise for it.
 *
 * Mirrors the C# `NodesBroadcastBuilder.Entry` record struct.
 */
export interface NodesBroadcastEntry {
  /** The destination node's callsign. */
  readonly destination: Callsign;
  /** The destination node's alias / mnemonic (may be empty). */
  readonly destinationAlias: string;
  /** The neighbour we forward through to reach it. */
  readonly bestNeighbour: Callsign;
  /** The quality to advertise (0..255). */
  readonly quality: number;
}

/**
 * Build the NODES broadcast frames advertising `entries` from a node whose alias
 * is `senderAlias`. Returns one info-field byte array per UI frame (entries
 * chunked {@link NODES_MAX_ENTRIES_PER_FRAME} per frame). An empty `entries`
 * yields a single header-only frame (the node announcing its presence with
 * nothing to advertise yet).
 *
 * Mirrors `NodesBroadcastBuilder.Build` on the C# side.
 *
 * @param senderAlias The broadcasting node's alias / mnemonic.
 * @param entries The destinations to advertise, best-first within the table.
 * @returns One info field (Uint8Array) per UI frame to transmit.
 */
export function buildNodesBroadcast(
  senderAlias: string,
  entries: readonly NodesBroadcastEntry[] = [],
): Uint8Array[] {
  const frames: Uint8Array[] = [];

  // Header-only broadcast when there's nothing to advertise — a node still
  // announces itself. (The receiver creates a neighbour entry for us from the UI
  // frame's source callsign regardless of the entry list.)
  const frameCount =
    entries.length === 0
      ? 1
      : Math.ceil(entries.length / NODES_MAX_ENTRIES_PER_FRAME);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * NODES_MAX_ENTRIES_PER_FRAME;
    const take = Math.min(
      NODES_MAX_ENTRIES_PER_FRAME,
      entries.length - start,
    );

    const buf = new Uint8Array(
      NODES_HEADER_LENGTH + take * NODES_ENTRY_ENCODED_LENGTH,
    );
    buf[0] = NODES_SIGNATURE;
    writeAlias(senderAlias, buf, 1);

    let offset = NODES_HEADER_LENGTH;
    for (let i = 0; i < take; i++) {
      const e = entries[start + i]!;
      writeShifted(e.destination, buf, offset);
      writeAlias(e.destinationAlias, buf, offset + NETROM_SHIFTED_LENGTH);
      writeShifted(
        e.bestNeighbour,
        buf,
        offset + NETROM_SHIFTED_LENGTH + NETROM_ALIAS_LENGTH,
      );
      buf[offset + NODES_ENTRY_ENCODED_LENGTH - 1] = e.quality & 0xff;
      offset += NODES_ENTRY_ENCODED_LENGTH;
    }

    frames.push(buf);
  }

  return frames;
}
