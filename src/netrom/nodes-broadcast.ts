import type { Callsign } from "../callsign.js";
import {
  NETROM_ALIAS_LENGTH,
  NETROM_SHIFTED_LENGTH,
  readAlias,
  tryReadShifted,
} from "./callsign.js";

/**
 * Per-call configuration for the NET/ROM wire-parse path
 * ({@link parseNodesBroadcast}). Each pragmatic accommodation for a real-world
 * node's divergence from the canonical NET/ROM wire format is a named,
 * individually-toggleable flag — exactly the `Ax25ParseOptions` / `XidParseOptions`
 * pattern this project uses for AX.25.
 *
 * **There is no single normative NET/ROM standard.** The closest thing to
 * canonical is the original protocol appendix
 * (`wiki.oarc.uk/_media/packet:thenetromprotocol.pdf`); in practice **G8BPQ /
 * LinBPQ is the de-facto reference**, with XRouter and the Linux kernel `netrom`
 * family diverging. We treat them all as interop targets, *not* reference truth
 * — the same discipline the AX.25 side mandates. So the parser is faithful to
 * the canonical appendix by default, and every divergence we accommodate is a
 * flag here (defaulted to preserve the canonical reading), surfaced in the
 * relevant peer preset. We never silently bake a BPQ-ism (or XRouter-ism) into
 * the parser.
 *
 * The current divergences are about *tolerance of the table dump*, not the field
 * layout (the 0xFF signature, the 6-byte alias, and the 21-byte destination
 * entries are universal). A node that pads its final UI frame, or that runs an
 * entry count not landing exactly on a 21-byte boundary, should not make us drop
 * the whole frame — but accepting that is opt-in, so a strict caller can still
 * reject a malformed dump.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomParseOptions` on the C# side.
 */
export interface NetRomParseOptions {
  /**
   * Accept a routing-info region whose length is not an exact multiple of the
   * 21-byte entry size: parse as many whole 21-byte entries as fit and ignore a
   * short trailing remainder. Strict canonical NET/ROM emits only whole entries,
   * so a remainder means either trailing pad or a truncated frame.
   *
   * Real nodes (BPQ included) have been observed padding the final UI frame of a
   * multi-frame NODES dump, and a noisy RF link can clip the tail of a frame.
   * Dropping every learned route because the *last* entry is short would be
   * hostile; we keep the whole entries we did parse. Default `true` (lenient) —
   * this is read-only ingest of third-party broadcasts, where resilience matters
   * more than rejecting a stray byte.
   */
  allowTrailingPartialEntry: boolean;
  /**
   * Accept a NODES broadcast carrying *zero* destination entries (just the 0xFF
   * signature + the 6-byte sender alias, info field exactly 7 bytes).
   *
   * A node with an empty routing table, or one announcing only its own presence,
   * can emit a header-only broadcast. The canonical appendix frames the entry
   * list as "repeated up to 11 times" — i.e. zero is in range. Still a flag
   * (default `true`) so a caller that wants to treat a contentless broadcast as
   * malformed can opt out.
   */
  allowEmptyDestinationList: boolean;
}

/**
 * Accept-everything mode (the kitchen sink). All currently-known accommodations
 * enabled. The single-argument {@link parseNodesBroadcast} overload uses this —
 * read-only promiscuous ingest wants to be forgiving.
 */
export const NETROM_PARSE_LENIENT: NetRomParseOptions = {
  allowTrailingPartialEntry: true,
  allowEmptyDestinationList: true,
};

/**
 * Strict canonical NET/ROM — every accommodation disabled. A broadcast is
 * accepted only if its routing-info region is an exact multiple of 21 bytes and
 * contains at least one destination entry.
 */
export const NETROM_PARSE_STRICT: NetRomParseOptions = {
  allowTrailingPartialEntry: false,
  allowEmptyDestinationList: false,
};

/**
 * BPQ / LinBPQ-flavoured leniency (the de-facto reference node). Today the same
 * settings as {@link NETROM_PARSE_LENIENT}; kept named so a future BPQ-specific
 * quirk lands here without churning call sites.
 */
export const NETROM_PARSE_BPQ: NetRomParseOptions = NETROM_PARSE_LENIENT;

/**
 * XRouter-flavoured leniency (Paula G8PZT). Today identical to
 * {@link NETROM_PARSE_LENIENT}. XRouter's notable divergence is the *quality* it
 * advertises (its RTT→quality conversion is deliberately lower — the "British
 * notion of quality"), which is a routing-table concern (see
 * `./routing-table.ts`), not a wire-parse concern — the bytes still parse
 * identically.
 */
export const NETROM_PARSE_XROUTER: NetRomParseOptions = NETROM_PARSE_LENIENT;

/** Octets one destination entry occupies on the wire (= 21). */
export const NODES_ENTRY_ENCODED_LENGTH =
  NETROM_SHIFTED_LENGTH + // 7  destination callsign
  NETROM_ALIAS_LENGTH + // 6  destination alias
  NETROM_SHIFTED_LENGTH + // 7  best-neighbour callsign
  1; // 1  best quality

/** The NET/ROM NODES-broadcast signature byte that opens the info field. */
export const NODES_SIGNATURE = 0xff;

/** The literal AX.25 destination callsign a NODES broadcast is addressed to. */
export const NODES_DESTINATION = "NODES";

/** Maximum destination entries the canonical format packs into one UI frame. */
export const NODES_MAX_ENTRIES_PER_FRAME = 11;

const NODES_HEADER_LENGTH = 1 + NETROM_ALIAS_LENGTH; // signature + 6-byte alias = 7

/**
 * One destination entry inside a NET/ROM NODES broadcast — a 21-octet record
 * advertising "I (the broadcasting node) can reach {@link destination} (alias
 * {@link destinationAlias}) via {@link bestNeighbour} at quality
 * {@link bestQuality}."
 *
 * Layout (canonical NET/ROM appendix), 21 octets:
 * ```
 *   [7] destination callsign    (AX.25 shifted form)
 *   [6] destination alias       (plain ASCII, space-padded, no SSID)
 *   [7] best-neighbour callsign (AX.25 shifted form)
 *   [1] best quality            (0 worst … 255 best)
 * ```
 *
 * {@link bestQuality} is the *advertised* quality as the originator sees it. The
 * receiving node combines it multiplicatively with its own path quality to the
 * originator to derive the route quality it stores — see `combineQuality` in
 * `./quality.ts`.
 *
 * Mirrors `Packet.NetRom.Wire.NodesRoutingEntry` on the C# side.
 */
export interface NodesRoutingEntry {
  /** The destination node this entry advertises a route to. */
  readonly destination: Callsign;
  /** The destination node's alias / mnemonic (may be empty). */
  readonly destinationAlias: string;
  /**
   * The neighbour the originator forwards through to reach {@link destination} —
   * the originator's own chosen best next hop.
   */
  readonly bestNeighbour: Callsign;
  /** The originator's quality for this route (0 worst … 255 best). */
  readonly bestQuality: number;
}

/**
 * A parsed NET/ROM NODES routing broadcast — the L3 content carried in the
 * information field of a UI frame (PID 0xCF, AX.25 destination the literal text
 * callsign `NODES`).
 *
 * Information-field layout (canonical NET/ROM appendix):
 * ```
 *   [1]  0xFF signature byte
 *   [6]  sender's alias / mnemonic (plain ASCII, space-padded)
 *   then up to 11 × 21-octet destination entries (NodesRoutingEntry)
 * ```
 *
 * A node's full routing table is dumped across as many UI frames as needed, each
 * frame carrying ≤ 11 entries. This type models *one* such frame's content; a
 * multi-frame dump produces several broadcasts, all merged into the routing
 * table independently (the table keys on destination, so frame boundaries don't
 * matter to the merge).
 *
 * Mirrors `Packet.NetRom.Wire.NodesBroadcast` on the C# side.
 */
export interface NodesBroadcast {
  /** The broadcasting node's alias / mnemonic (may be empty). */
  readonly senderAlias: string;
  /** The destination entries carried in this frame (0..11). */
  readonly entries: readonly NodesRoutingEntry[];
}

/**
 * Decode one 21-octet entry. Returns `null` if the span is too short or either
 * callsign field fails to decode.
 */
function parseEntry(
  source: Uint8Array,
  offset: number,
): NodesRoutingEntry | null {
  if (source.length < offset + NODES_ENTRY_ENCODED_LENGTH) {
    return null;
  }
  let o = offset;
  const destination = tryReadShifted(source, o);
  if (destination === null) {
    return null;
  }
  o += NETROM_SHIFTED_LENGTH;

  const destinationAlias = readAlias(source, o);
  o += NETROM_ALIAS_LENGTH;

  const bestNeighbour = tryReadShifted(source, o);
  if (bestNeighbour === null) {
    return null;
  }
  o += NETROM_SHIFTED_LENGTH;

  const bestQuality = source[o]!;

  return { destination, destinationAlias, bestNeighbour, bestQuality };
}

/**
 * Try to parse a NODES broadcast from a UI frame's information field, applying
 * `options` for the strict-vs-lenient divergence choices. Returns `null` (never
 * throws) on any malformed input. Defaults to {@link NETROM_PARSE_LENIENT} — the
 * promiscuous-ingest default.
 *
 * Parsing is read-only and total: arbitrary bytes never throw, they return
 * `null`. Divergence tolerance (trailing partial entry, empty list) is gated by
 * {@link NetRomParseOptions} — strict by default at the byte boundary, lenient on
 * the default overload used for promiscuous ingest.
 *
 * Mirrors `Packet.NetRom.Wire.NodesBroadcast.TryParse` on the C# side.
 */
export function parseNodesBroadcast(
  info: Uint8Array,
  options: NetRomParseOptions = NETROM_PARSE_LENIENT,
): NodesBroadcast | null {
  // Need at least the signature + 6-byte alias.
  if (info.length < NODES_HEADER_LENGTH) {
    return null;
  }

  // Signature byte gates the whole frame — a non-0xFF first octet means this is
  // not a NODES broadcast (the canonical "wrong signature → ignore" heuristic).
  if (info[0] !== NODES_SIGNATURE) {
    return null;
  }

  const senderAlias = readAlias(info, 1);

  const bodyLength = info.length - NODES_HEADER_LENGTH;
  const entryCount = Math.floor(bodyLength / NODES_ENTRY_ENCODED_LENGTH);
  const remainder = bodyLength - entryCount * NODES_ENTRY_ENCODED_LENGTH;

  // A non-zero remainder means the routing region isn't a whole number of
  // 21-byte entries — either trailing pad / a clipped frame, or a malformed
  // dump. Strict rejects; lenient keeps the whole entries it can read.
  if (remainder !== 0 && !options.allowTrailingPartialEntry) {
    return null;
  }

  // Cap at the canonical 11-per-frame: a frame claiming more than that is out of
  // spec, so we ignore the surplus rather than trust it.
  const take = Math.min(entryCount, NODES_MAX_ENTRIES_PER_FRAME);

  if (take === 0 && !options.allowEmptyDestinationList) {
    return null;
  }

  const entries: NodesRoutingEntry[] = [];
  let offset = NODES_HEADER_LENGTH;
  for (let i = 0; i < take; i++) {
    const entry = parseEntry(info, offset);
    if (entry === null) {
      // A single undecodable entry shouldn't sink the frame under lenient
      // ingest — skip it and keep parsing the rest. Under strict, a bad entry
      // is a malformed broadcast.
      if (!options.allowTrailingPartialEntry) {
        return null;
      }
      offset += NODES_ENTRY_ENCODED_LENGTH;
      continue;
    }
    entries.push(entry);
    offset += NODES_ENTRY_ENCODED_LENGTH;
  }

  return { senderAlias, entries };
}
