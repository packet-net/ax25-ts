import type { Callsign } from "../callsign.js";
import {
  NETROM_SHIFTED_LENGTH,
  tryReadShifted,
  writeShifted,
} from "./callsign.js";

/**
 * Codec for the INP3 Routing Information Frame (RIF) and its constituents — the
 * `0xFF`-signed routing-information body carried in the information field of a
 * connected-mode interlink I-frame (PID 0xCF):
 *
 * - {@link Inp3Tlv} — one type/length/value record inside a RIP (alias / IP /
 *   unknown-retained-verbatim).
 * - {@link Inp3Rip} — one Routing Information Packet (a single routing entry).
 * - {@link Inp3Rif} — the whole `0xFF`-signed frame: a signature byte followed
 *   by one or more RIPs, each self-delimited by its `0x00` EOP.
 *
 * A RIF is the connected-mode analogue of a NODES broadcast — both lead with the
 * `0xFF` signature, both are a self-delimited sequence of fixed-prefix entries —
 * so this module mirrors `./nodes-broadcast.ts`'s shape: total / never-throw
 * parsing, a lenient-by-default {@link Inp3ParseOptions} surface with the same
 * preset names (`Strict` / `Lenient` / `Bpq` / `Xrouter`), and the shifted-callsign
 * codec reused from `./callsign.ts` so the shift/SSID semantics have one home.
 *
 * Byte layouts and every hex vector here are LOCKED in
 * `docs/netrom-inp3-i1-wire-spec.md` §2 (packet.net). Wire parity against that
 * document is the correctness gate.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Rif` / `Inp3Rip` / `Inp3Tlv` / `Inp3ParseOptions`
 * on the C# side.
 */

// ─── Parse options (mirror NetRomParseOptions / Inp3ParseOptions) ───────────

/**
 * Per-call configuration for the INP3 RIF wire-parse path
 * ({@link parseInp3Rif}). Mirrors {@link NetRomParseOptions} one-for-one: each
 * tolerance of a real-world peer's divergence from the canonical INP3 wire
 * format is a named, individually-toggleable flag with the same preset surface
 * (`Strict` / `Lenient` / `Bpq` / `Xrouter`).
 *
 * A RIF is the connected-mode analogue of a NODES broadcast — both lead with the
 * `0xFF` signature, both are a self-delimited sequence of fixed-prefix entries —
 * so the strict-by-default / lenient-on-promiscuous-ingest discipline is
 * identical. The two currently-known divergences are about *tolerance of the
 * entry list* (an empty list, a clipped trailing RIP), not the field layout,
 * exactly as for NODES.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3ParseOptions` on the C# side.
 */
export interface Inp3ParseOptions {
  /**
   * Accept a RIF body carrying *zero* RIPs (just the `0xFF` signature). The
   * connected-mode analogue of
   * {@link NetRomParseOptions.allowEmptyDestinationList}.
   *
   * A neighbour with nothing new to advertise can in principle send a
   * signature-only RIF. Default `true` (lenient); a strict caller can treat a
   * contentless RIF as malformed.
   */
  allowEmptyRipList: boolean;
  /**
   * Accept a RIF whose final RIP is truncated (the body ends mid-RIP, or a TLV's
   * claimed length runs off the end of the body): keep every whole RIP parsed so
   * far and drop the clipped tail. The RIF analogue of
   * {@link NetRomParseOptions.allowTrailingPartialEntry}.
   *
   * Driver: a noisy RF interlink can clip the tail of an I-frame. Dropping every
   * learned route because the *last* RIP is short would be hostile; we keep the
   * whole RIPs we did parse. Default `true` (lenient). Under `Strict` any
   * leftover byte that does not complete a RIP rejects the whole frame.
   */
  allowTrailingPartialRip: boolean;
}

/**
 * Accept-everything mode. All currently-known accommodations enabled. The
 * single-argument {@link parseInp3Rif} overload uses this — read-only
 * promiscuous ingest wants to be forgiving.
 */
export const INP3_PARSE_LENIENT: Inp3ParseOptions = {
  allowEmptyRipList: true,
  allowTrailingPartialRip: true,
};

/**
 * Strict canonical INP3 — every accommodation disabled. A RIF is accepted only
 * if every byte after the signature forms a whole RIP and there is at least one
 * RIP.
 */
export const INP3_PARSE_STRICT: Inp3ParseOptions = {
  allowEmptyRipList: false,
  allowTrailingPartialRip: false,
};

/**
 * BPQ / LinBPQ-flavoured leniency. Today the same instance as
 * {@link INP3_PARSE_LENIENT}; kept named so a future BPQ-specific INP3 quirk
 * lands here without churning call sites (the {@link NETROM_PARSE_BPQ} pattern).
 */
export const INP3_PARSE_BPQ: Inp3ParseOptions = INP3_PARSE_LENIENT;

/**
 * XRouter-flavoured leniency (Paula G8PZT). Today identical to
 * {@link INP3_PARSE_LENIENT}; kept named for symmetry with
 * {@link NETROM_PARSE_XROUTER}.
 */
export const INP3_PARSE_XROUTER: Inp3ParseOptions = INP3_PARSE_LENIENT;

// ─── TLV (Inp3Tlv) ──────────────────────────────────────────────────────────

/** TLV type: the destination's ASCII alias / mnemonic. */
export const INP3_TLV_ALIAS_TYPE = 0x00;

/** TLV type: an IP address (value length 4 = IPv4, 16 = IPv6). */
export const INP3_TLV_IP_TYPE = 0x01;

/**
 * One INP3 type/length/value record carried inside a RIP (an {@link Inp3Rip}).
 * Encoded on the wire as `[type][len][value…]` where `len` is a single octet
 * equal to {@link value}'s length (0..255).
 *
 * Two types have defined meaning (INP3 spec / plan §4.2):
 *
 * - {@link INP3_TLV_ALIAS_TYPE} (`0x00`) — the destination's ASCII alias /
 *   mnemonic. Decode with {@link inp3TlvAsAlias}.
 * - {@link INP3_TLV_IP_TYPE} (`0x01`) — an IP address; {@link value} length 4 =
 *   IPv4, 16 = IPv6. Decode with {@link inp3TlvAsIpAddress}.
 *
 * **Unknown types are retained verbatim.** Any TLV whose type is neither of the
 * above is preserved exactly (type + value bytes) and re-emitted unchanged when
 * the RIP is forwarded — a RIP is never dropped for carrying a TLV we don't
 * understand (forward-compat, plan §4.2/§4.3). {@link inp3TlvIsKnown} reports
 * whether the type is one we interpret.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Tlv` on the C# side.
 */
export interface Inp3Tlv {
  /** The TLV type octet. */
  readonly type: number;
  /** The TLV value bytes (0..255). Retained verbatim for unknown types. */
  readonly value: Uint8Array;
}

/**
 * Octets this TLV occupies on the wire: `1 (type) + 1 (len) + value.length`.
 * Mirrors `Inp3Tlv.EncodedLength`.
 */
export function inp3TlvEncodedLength(tlv: Inp3Tlv): number {
  return 2 + tlv.value.length;
}

/**
 * `true` if `tlv.type` is a type this codec interprets
 * ({@link INP3_TLV_ALIAS_TYPE} or {@link INP3_TLV_IP_TYPE}); `false` for an
 * unknown type retained verbatim. Mirrors `Inp3Tlv.IsKnown`.
 */
export function inp3TlvIsKnown(tlv: Inp3Tlv): boolean {
  return tlv.type === INP3_TLV_ALIAS_TYPE || tlv.type === INP3_TLV_IP_TYPE;
}

/**
 * Build an alias TLV ({@link INP3_TLV_ALIAS_TYPE}) from a mnemonic string. The
 * printable-ASCII characters of `alias` are written verbatim (no padding, no
 * shift) — the alias is variable-length inside a TLV, unlike the fixed 6-byte
 * NODES alias field. Any non-printable character is replaced with a space so a
 * stray control / high-bit char can never reach the wire.
 *
 * Mirrors `Inp3Tlv.Alias`.
 */
export function inp3TlvAlias(alias: string): Inp3Tlv {
  const bytes = new Uint8Array(alias.length);
  for (let i = 0; i < alias.length; i++) {
    const code = alias.charCodeAt(i);
    bytes[i] = code >= 0x20 && code <= 0x7e ? code : 0x20;
  }
  return { type: INP3_TLV_ALIAS_TYPE, value: bytes };
}

/**
 * Build an IP TLV ({@link INP3_TLV_IP_TYPE}) from raw address bytes (4 octets =
 * IPv4, 16 octets = IPv6). The bytes are taken verbatim — this is the analogue
 * of the C# `Inp3Tlv.Ip(IPAddress)`, which calls `address.GetAddressBytes()`.
 * The TS library has no built-in IP-address type, so the codec works in the
 * network-order address bytes directly; {@link inp3TlvAsIpAddress} decodes them
 * back to a display string.
 *
 * Mirrors `Inp3Tlv.Ip`.
 */
export function inp3TlvIp(addressBytes: Uint8Array): Inp3Tlv {
  return { type: INP3_TLV_IP_TYPE, value: Uint8Array.from(addressBytes) };
}

/**
 * Decode `tlv.value` as a trimmed ASCII alias string. Returns the printable
 * characters only (a corrupted octet is dropped, never rendered as mojibake)
 * with trailing spaces stripped — the same discipline as
 * {@link readAlias}. Meaningful only when `tlv.type` is
 * {@link INP3_TLV_ALIAS_TYPE}, but works on any value.
 *
 * Mirrors `Inp3Tlv.AsAlias`.
 */
export function inp3TlvAsAlias(tlv: Inp3Tlv): string {
  let out = "";
  for (let i = 0; i < tlv.value.length; i++) {
    const code = tlv.value[i]!;
    if (code >= 0x20 && code <= 0x7e) {
      out += String.fromCharCode(code);
    }
  }
  return out.replace(/\s+$/, "");
}

/**
 * Decode `tlv.value` as an IP-address display string when it is a 4-octet (IPv4
 * dotted-decimal) or 16-octet (IPv6, RFC 5952-ish compressed) value; returns
 * `null` for any other length (never throws). Meaningful only when `tlv.type` is
 * {@link INP3_TLV_IP_TYPE}, but works on any value of the right length.
 *
 * The C# `Inp3Tlv.AsIpAddress` returns a `System.Net.IPAddress`; the TS library
 * has no built-in IP type, so the parity-equivalent here is the canonical
 * address string (`"44.131.91.2"`, `"2001:db8::1"`). The raw bytes are always
 * available verbatim on {@link Inp3Tlv.value}.
 *
 * Mirrors `Inp3Tlv.AsIpAddress`.
 */
export function inp3TlvAsIpAddress(tlv: Inp3Tlv): string | null {
  const n = tlv.value.length;
  if (n === 4) {
    return `${tlv.value[0]}.${tlv.value[1]}.${tlv.value[2]}.${tlv.value[3]}`;
  }
  if (n === 16) {
    return formatIpv6(tlv.value);
  }
  return null;
}

/**
 * Encode a TLV (`[type][len][value…]`) into `dest` at `offset`
 * (≥ {@link inp3TlvEncodedLength} octets of room). Mirrors `Inp3Tlv.Write`.
 *
 * @throws If the value is longer than 255 octets (cannot be length-prefixed by a
 *   single byte) — a construction bug; we never emit a malformed TLV.
 * @throws If `dest` does not have room for the encoded TLV at `offset`.
 */
export function writeInp3Tlv(tlv: Inp3Tlv, dest: Uint8Array, offset = 0): void {
  if (tlv.value.length > 255) {
    throw new Error(
      `TLV value must be 0..255 octets to length-prefix (got ${tlv.value.length})`,
    );
  }
  const need = inp3TlvEncodedLength(tlv);
  if (dest.length < offset + need) {
    throw new Error(
      `TLV needs ${need} bytes of room (got ${dest.length - offset})`,
    );
  }
  dest[offset] = tlv.type;
  dest[offset + 1] = tlv.value.length;
  dest.set(tlv.value, offset + 2);
}

// ─── RIP (Inp3Rip) ──────────────────────────────────────────────────────────

/** Octets of fixed prefix before the TLV region: 7 callsign + 1 hop + 2 target-time (= 10). */
export const INP3_RIP_PREFIX_LENGTH = NETROM_SHIFTED_LENGTH + 1 + 2;

/** Target-time units (10 ms each) at the routing horizon — destination unreachable (`0xEA60` = 60000). */
export const INP3_HORIZON_UNITS = 0xea60;

/** The routing horizon in milliseconds (600.000 s). A target time at or above this is a withdrawal. */
export const INP3_HORIZON_MS = INP3_HORIZON_UNITS * 10; // 600_000

/** The EOP (end-of-packet) terminator byte that closes a RIP on the wire. */
export const INP3_END_OF_PACKET = 0x00;

/**
 * One INP3 Routing Information Packet — a single routing entry inside a
 * {@link Inp3Rif}: "destination {@link destination} is reachable in
 * {@link hopCount} hops with a measured target time of {@link targetTimeMs} ms,"
 * plus zero or more {@link Inp3Tlv} records.
 *
 * Wire layout (plan §4.2):
 * ```
 *   [7] destination callsign  (AX.25 shifted form; reuse the ./callsign.ts codec)
 *   [1] hop count
 *   [2] target time           MSB-first, 10 ms units (0..65535 → 0..655.35 s)
 *   [*] TLV fields            zero or more [type][len][value] records (Inp3Tlv)
 *   [1] 0x00                  EOP (end-of-packet) terminator
 * ```
 *
 * **The horizon.** A target time at or above {@link INP3_HORIZON_MS} (`0xEA60`
 * units = 600.000 s) marks the destination unreachable; a RIP at the horizon is
 * a route *withdrawal* (plan §5.3). This codec decodes the value faithfully and
 * exposes {@link inp3RipIsHorizon} so the routing layer need not re-derive the
 * constant; the act of withdrawing the route is out of scope here (INP3 slice
 * I-3).
 *
 * **Alias TLV vs EOP.** An alias TLV has type `0x00`, identical to the EOP byte;
 * they are distinguished positionally (spec §2.3, AMBIGUITY-RIF-2, locked
 * reading (a)): a `0x00` followed by a length byte and that many value bytes
 * still inside the body is an alias TLV; a `0x00` that cannot be satisfied as a
 * TLV is the EOP. {@link parseInp3Rip} implements exactly that.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Rip` on the C# side.
 */
export interface Inp3Rip {
  /** The destination node this RIP advertises a route to. */
  readonly destination: Callsign;
  /** Hop count to {@link destination}. */
  readonly hopCount: number;
  /**
   * Target time to the destination, in milliseconds. On the wire this is a
   * MSB-first 16-bit count of 10 ms units, so the stored value is always a
   * multiple of 10 in the range 0..655350.
   */
  readonly targetTimeMs: number;
  /** The TLV records carried by this RIP (alias / IP / unknown), in wire order. May be empty. */
  readonly tlvs: readonly Inp3Tlv[];
}

/**
 * `true` if `rip.targetTimeMs` is at or above the routing horizon
 * ({@link INP3_HORIZON_MS}) — i.e. this RIP withdraws the route. Mirrors
 * `Inp3Rip.IsHorizon`.
 */
export function inp3RipIsHorizon(rip: Inp3Rip): boolean {
  return rip.targetTimeMs >= INP3_HORIZON_MS;
}

/**
 * The first alias TLV's decoded string, or `null` if this RIP carries no alias
 * TLV. Convenience over scanning `rip.tlvs`. Mirrors `Inp3Rip.Alias`.
 */
export function inp3RipAlias(rip: Inp3Rip): string | null {
  for (const tlv of rip.tlvs) {
    if (tlv.type === INP3_TLV_ALIAS_TYPE) {
      return inp3TlvAsAlias(tlv);
    }
  }
  return null;
}

/**
 * Octets this RIP occupies on the wire: prefix + every TLV + the EOP byte.
 * Mirrors `Inp3Rip.EncodedLength`.
 */
export function inp3RipEncodedLength(rip: Inp3Rip): number {
  let len = INP3_RIP_PREFIX_LENGTH;
  for (const tlv of rip.tlvs) {
    len += inp3TlvEncodedLength(tlv);
  }
  return len + 1; // EOP
}

/**
 * Encode a RIP into `dest` at `offset` (≥ {@link inp3RipEncodedLength} octets of
 * room). Mirrors `Inp3Rip.Write`.
 *
 * @throws If a field is out of encodable range (target time, or a TLV value over
 *   255 octets) — a construction bug; we never emit a malformed RIP.
 * @throws If `dest` does not have room for the encoded RIP at `offset`.
 */
export function writeInp3Rip(rip: Inp3Rip, dest: Uint8Array, offset = 0): void {
  const units = Math.trunc(rip.targetTimeMs / 10);
  if (rip.targetTimeMs < 0 || units > 0xffff) {
    throw new Error(
      `target time must be 0..655350 ms to encode (got ${rip.targetTimeMs})`,
    );
  }
  const need = inp3RipEncodedLength(rip);
  if (dest.length < offset + need) {
    throw new Error(
      `RIP needs ${need} bytes of room (got ${dest.length - offset})`,
    );
  }

  let o = offset;
  writeShifted(rip.destination, dest, o);
  o += NETROM_SHIFTED_LENGTH;

  dest[o++] = rip.hopCount & 0xff;
  dest[o++] = (units >> 8) & 0xff; // MSB first
  dest[o++] = units & 0xff;

  for (const tlv of rip.tlvs) {
    writeInp3Tlv(tlv, dest, o);
    o += inp3TlvEncodedLength(tlv);
  }

  dest[o] = INP3_END_OF_PACKET;
}

/** Allocate and return a RIP's wire encoding. Mirrors `Inp3Rip.ToBytes`. */
export function inp3RipToBytes(rip: Inp3Rip): Uint8Array {
  const buf = new Uint8Array(inp3RipEncodedLength(rip));
  writeInp3Rip(rip, buf, 0);
  return buf;
}

/** The result of {@link parseInp3Rip}: the decoded RIP and how many octets it consumed. */
export interface Inp3RipParseResult {
  /** The decoded RIP. */
  readonly rip: Inp3Rip;
  /** Octets consumed from the front of the source (prefix + TLVs + EOP). */
  readonly consumed: number;
}

/**
 * Try to decode one RIP from the front of `source` (optionally starting at
 * `offset`), reporting how many octets it consumed (prefix + TLVs + EOP).
 * Returns `null` (never throws) on any input that is too short or cannot be
 * framed as a whole RIP — a truncated prefix, a callsign field that fails to
 * decode, a TLV whose claimed length runs off the end of `source`, or a RIP with
 * no terminating EOP.
 *
 * `source` is the RIF body at this RIP's start (it may contain further RIPs
 * after this one — only the consumed prefix is parsed here).
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Rip.TryParse`.
 */
export function parseInp3Rip(
  source: Uint8Array,
  offset = 0,
): Inp3RipParseResult | null {
  const len = source.length;
  if (len - offset < INP3_RIP_PREFIX_LENGTH) {
    return null;
  }

  const dest = tryReadShifted(source, offset);
  if (dest === null) {
    return null;
  }
  let o = offset + NETROM_SHIFTED_LENGTH;

  const hop = source[o++]!;
  const units = (source[o]! << 8) | source[o + 1]!; // MSB first
  o += 2;

  // Walk the TLV region. The EOP is a 0x00 that cannot be satisfied as a TLV; an
  // alias TLV (type 0x00) is a 0x00 followed by [len][value] that still fits
  // inside the body (AMBIGUITY-RIF-2, locked reading (a)).
  const tlvs: Inp3Tlv[] = [];
  for (;;) {
    if (o >= len) {
      // Ran out of bytes before an EOP — the RIP is truncated.
      return null;
    }

    const type = source[o]!;

    if (type === INP3_END_OF_PACKET) {
      // Could be EOP, or the start of an alias TLV (type 0x00). It is a TLV iff a
      // length byte follows AND that many value bytes still fit inside the source
      // before its end. Otherwise it is the EOP.
      //
      // This "fits → alias, else → EOP" rule is forced by AMBIGUITY-RIF-2 (alias
      // type == EOP == 0x00) and is exactly what lets a multi-RIP RIF find its
      // boundaries: a real EOP is followed by the next RIP's shifted callsign,
      // whose first octet (≈0x80+) frames as an alias length that overruns the
      // remaining body, so it reads as EOP. The unavoidable consequence: a
      // *truncated* trailing alias is indistinguishable from EOP-plus-partial, so
      // it degrades to a RIP that keeps its route but drops the malformed alias
      // (the residual flagged for I-5 interop validation; alias *emission* stays
      // gated off until then). Never panics either way — the fuzz contract holds.
      const isTlv =
        o + 1 < len && // room for a len byte
        o + 2 + source[o + 1]! <= len; // room for len value bytes

      if (!isTlv) {
        // EOP — RIP ends here.
        o += 1;
        break;
      }
    } else {
      // Non-zero type must have a length byte.
      if (o + 1 >= len) {
        return null;
      }
    }

    const tlvLen = source[o + 1]!;
    const valueStart = o + 2;
    if (valueStart + tlvLen > len) {
      // TLV claims more value bytes than remain — truncated.
      return null;
    }

    const value = source.slice(valueStart, valueStart + tlvLen);
    tlvs.push({ type, value });
    o = valueStart + tlvLen;
  }

  return {
    rip: {
      destination: dest,
      hopCount: hop,
      targetTimeMs: units * 10,
      tlvs,
    },
    consumed: o - offset,
  };
}

// ─── RIF (Inp3Rif) ──────────────────────────────────────────────────────────

/** The INP3 RIF signature byte that opens the info-field body (shared with NODES; disambiguated by carrier). */
export const INP3_RIF_SIGNATURE = 0xff;

/**
 * A parsed INP3 Routing Information Frame — the `0xFF`-signed body carried in the
 * information field of a connected-mode interlink I-frame (PID 0xCF). It is the
 * connected-mode analogue of a {@link NodesBroadcast}: a signature byte followed
 * by a self-delimited sequence of routing entries ({@link Inp3Rip}), each closed
 * by its own EOP.
 *
 * Body layout (plan §4.2):
 * ```
 *   [1]  0xFF  signature (gates the whole body; non-0xFF → not a RIF → null)
 *   then 1..N RIPs, each self-delimited by its 0x00 EOP
 * ```
 *
 * This type models the I-frame's *info-field body*, exactly as
 * {@link NodesBroadcast} models a UI info field — not the surrounding AX.25
 * frame. RIF and NODES are **never confused** despite both leading with `0xFF`:
 * they arrive on different carriers (RIF on a connected I-frame, NODES on a UI
 * frame to dest `NODES`), so the caller selects the codec by carrier — there is
 * no content-sniffing (AMBIGUITY-RIF-1).
 *
 * Parsing is read-only and total: arbitrary, truncated or adversarial bytes
 * never throw — they return `null`. Divergence tolerance (empty RIP list, a
 * clipped trailing RIP) is gated by {@link Inp3ParseOptions} — strict by
 * default, lenient on the single-argument {@link parseInp3Rif} overload used for
 * promiscuous ingest.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Rif` on the C# side.
 */
export interface Inp3Rif {
  /** The RIPs carried in this RIF, in wire order. May be empty (lenient) but never `null`. */
  readonly rips: readonly Inp3Rip[];
}

/**
 * Octets this RIF occupies on the wire: the signature byte + every RIP. Mirrors
 * `Inp3Rif.EncodedLength`.
 */
export function inp3RifEncodedLength(rif: Inp3Rif): number {
  let len = 1; // signature
  for (const rip of rif.rips) {
    len += inp3RipEncodedLength(rip);
  }
  return len;
}

/**
 * Encode a RIF into `dest` at `offset` (≥ {@link inp3RifEncodedLength} octets of
 * room). Mirrors `Inp3Rif.Write`.
 *
 * @throws If `dest` does not have room for the encoded RIF at `offset`.
 */
export function writeInp3Rif(rif: Inp3Rif, dest: Uint8Array, offset = 0): void {
  const need = inp3RifEncodedLength(rif);
  if (dest.length < offset + need) {
    throw new Error(
      `RIF needs ${need} bytes of room (got ${dest.length - offset})`,
    );
  }

  dest[offset] = INP3_RIF_SIGNATURE;
  let o = offset + 1;
  for (const rip of rif.rips) {
    writeInp3Rip(rip, dest, o);
    o += inp3RipEncodedLength(rip);
  }
}

/**
 * Allocate and return a RIF's wire encoding (the I-frame info field). Mirrors
 * `Inp3Rif.ToBytes`.
 */
export function inp3RifToBytes(rif: Inp3Rif): Uint8Array {
  const buf = new Uint8Array(inp3RifEncodedLength(rif));
  writeInp3Rif(rif, buf, 0);
  return buf;
}

/**
 * Try to parse a RIF body from an interlink I-frame's information field, applying
 * `options` for the strict-vs-lenient divergence choices. Returns `null` (never
 * throws) on any malformed input — empty, wrong signature, truncated, or
 * adversarial. Defaults to {@link INP3_PARSE_LENIENT} — the promiscuous-ingest
 * default.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3Rif.TryParse`.
 */
export function parseInp3Rif(
  info: Uint8Array,
  options: Inp3ParseOptions = INP3_PARSE_LENIENT,
): Inp3Rif | null {
  // Need at least the signature byte.
  if (info.length < 1) {
    return null;
  }

  // Signature gates the whole body — a non-0xFF first octet means this is not a
  // RIF (the same "wrong signature → ignore" heuristic NODES uses).
  if (info[0] !== INP3_RIF_SIGNATURE) {
    return null;
  }

  const rips: Inp3Rip[] = [];
  let offset = 1;
  while (offset < info.length) {
    const result = parseInp3Rip(info, offset);
    if (result === null) {
      // A RIP that doesn't frame cleanly (truncated, bad callsign, a TLV running
      // off the end). Under lenient, keep the whole RIPs already parsed and drop
      // the clipped tail (RF-clip tolerance). Under strict, any leftover that
      // doesn't complete a RIP rejects the whole frame.
      if (!options.allowTrailingPartialRip) {
        return null;
      }
      break;
    }

    rips.push(result.rip);
    // Defensive: a zero-consumed RIP would loop forever. parseInp3Rip always
    // consumes at least the prefix + EOP on success, but guard anyway.
    if (result.consumed <= 0) {
      break;
    }
    offset += result.consumed;
  }

  if (rips.length === 0 && !options.allowEmptyRipList) {
    return null;
  }

  return { rips };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Format 16 network-order bytes as a compressed IPv6 string (lowercase, the
 * longest run of zero groups collapsed to `::`, à la RFC 5952). Display-only —
 * the raw bytes are always available verbatim on the TLV.
 */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  }

  // Find the longest run of consecutive zero groups (length ≥ 2 to collapse).
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart < 0) {
        runStart = i;
        runLen = 1;
      } else {
        runLen++;
      }
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(":");
  }

  const head = groups.slice(0, bestStart).map((g) => g.toString(16));
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${head.join(":")}::${tail.join(":")}`;
}
