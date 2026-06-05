import { Callsign } from "../callsign.js";
import {
  ADDRESS_ENCODED_LENGTH,
  readAddress,
  writeAddress,
} from "../address.js";

/**
 * Codecs for the two callsign/text encodings a NET/ROM NODES broadcast (and the
 * L4 / L3-origination headers) use. NET/ROM rides on AX.25, so a *callsign*
 * field is the familiar 7-octet AX.25 shifted form (6 chars left-shifted by one,
 * plus the SSID byte) — but a node's 6-character *alias / mnemonic* is plain
 * space-padded ASCII, not shifted, and has no SSID octet.
 *
 * These are deliberately small free functions rather than a type: the parsed
 * results are ordinary {@link Callsign}s (for callsign fields) and trimmed
 * strings (for alias fields), so they flow straight into the routing model
 * without a wrapper. The 7-octet codec delegates to {@link readAddress} /
 * {@link writeAddress} — the same shifted-callsign codec the frame layer uses —
 * so there is one source of truth for the shift/SSID/EOA semantics.
 *
 * Mirrors `Packet.NetRom.Wire.NetRomCallsign` on the C# side.
 */

/** Octets occupied by an AX.25 shifted callsign field (with SSID byte). */
export const NETROM_SHIFTED_LENGTH = ADDRESS_ENCODED_LENGTH; // 7

/** Octets occupied by a NET/ROM alias / mnemonic field (plain ASCII, no SSID). */
export const NETROM_ALIAS_LENGTH = 6;

/**
 * Decode a 7-octet AX.25 shifted callsign field (callsign chars in the upper
 * 7 bits, SSID + flags in the 7th octet). The end-of-address / command bits in
 * the SSID octet are read but not significant here — inside a NODES entry these
 * fields are payload, not an AX.25 address chain.
 *
 * Tolerant of an all-space ("empty") base: some nodes pad an absent
 * best-neighbour slot, and {@link readAddress} otherwise throws on the
 * non-space-after-padding it would see. The routing-table builder decides what
 * an empty callsign means; the codec just decodes faithfully. (This is the TS
 * analogue of the C# `Ax25ParseOptions.Lenient` pass.)
 *
 * @param source The field bytes — at least {@link NETROM_SHIFTED_LENGTH} octets.
 * @param offset Offset into `source` of the field's first octet.
 * @returns The decoded {@link Callsign}, or `null` if the field is too short or
 *   does not decode to a syntactically valid callsign.
 */
export function tryReadShifted(
  source: Uint8Array,
  offset = 0,
): Callsign | null {
  if (source.length < offset + NETROM_SHIFTED_LENGTH) {
    return null;
  }
  try {
    return readAddress(source, offset).callsign;
  } catch {
    // readAddress throws on a non-A-Z/0-9 char or a non-space octet after
    // padding. An all-space field is the one "bad padding" case we tolerate
    // (it is a blank base, which Callsign permits) — recover it by hand.
    if (isAllSpaceBase(source, offset)) {
      const ssidByte = source[offset + 6]!;
      const ssid = (ssidByte >> 1) & 0x0f;
      try {
        return new Callsign("", ssid);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Decode a 6-octet NET/ROM alias / mnemonic field: plain ASCII, space-padded on
 * the right, no shift and no SSID. Trailing spaces are stripped; an all-space
 * field yields the empty string. Non-printable octets are dropped (a noisy link
 * can corrupt a byte) so the result is always a clean display string.
 *
 * @param source The field bytes — at least {@link NETROM_ALIAS_LENGTH} octets.
 * @param offset Offset into `source` of the field's first octet.
 * @returns The trimmed alias, or `""` if blank / too short.
 */
export function readAlias(source: Uint8Array, offset = 0): string {
  if (source.length < offset + NETROM_ALIAS_LENGTH) {
    return "";
  }
  let out = "";
  for (let i = 0; i < NETROM_ALIAS_LENGTH; i++) {
    const code = source[offset + i]!;
    // Printable ASCII only (0x20..0x7E). Anything else (a corrupted or
    // high-bit octet) is skipped rather than rendered as mojibake.
    if (code >= 0x20 && code <= 0x7e) {
      out += String.fromCharCode(code);
    }
  }
  return out.replace(/\s+$/, "");
}

/**
 * Encode a callsign into a 7-octet AX.25 shifted callsign field (the form a NODES
 * entry / L3 network header uses for a callsign). Delegates to
 * {@link writeAddress} so the shift/SSID encoding has one source of truth with
 * the frame layer. The end-of-address and command/H bits are written clear —
 * inside a NODES entry / L3 header these fields are payload, not an AX.25 address
 * chain.
 *
 * @param callsign The callsign to encode.
 * @param dest The destination buffer — at least {@link NETROM_SHIFTED_LENGTH}
 *   octets of room from `offset`.
 * @param offset Offset into `dest` of the field's first octet.
 * @throws If `dest` does not have room for the 7-octet field at `offset`.
 */
export function writeShifted(
  callsign: Callsign,
  dest: Uint8Array,
  offset = 0,
): void {
  if (dest.length < offset + NETROM_SHIFTED_LENGTH) {
    throw new Error(
      `shifted callsign needs ${NETROM_SHIFTED_LENGTH} bytes of room (got ${dest.length - offset})`,
    );
  }
  writeAddress(dest, offset, {
    callsign,
    crhBit: false,
    extensionBit: false,
  });
}

/**
 * Encode a NET/ROM alias / mnemonic into a 6-octet field: plain ASCII,
 * right-padded with spaces, no shift and no SSID. Only the first
 * {@link NETROM_ALIAS_LENGTH} characters are written; non-printable characters
 * are replaced with a space so a stray control char can never reach the wire.
 *
 * @param alias The alias to encode (may be empty).
 * @param dest The destination buffer — at least {@link NETROM_ALIAS_LENGTH}
 *   octets of room from `offset`.
 * @param offset Offset into `dest` of the field's first octet.
 * @throws If `dest` does not have room for the 6-octet field at `offset`.
 */
export function writeAlias(alias: string, dest: Uint8Array, offset = 0): void {
  if (dest.length < offset + NETROM_ALIAS_LENGTH) {
    throw new Error(
      `alias needs ${NETROM_ALIAS_LENGTH} bytes of room (got ${dest.length - offset})`,
    );
  }
  for (let i = 0; i < NETROM_ALIAS_LENGTH; i++) {
    const code = i < alias.length ? alias.charCodeAt(i) : 0x20;
    // Printable ASCII only (0x20..0x7E); anything else becomes a space so a
    // stray control / high-bit char can never reach the wire.
    dest[offset + i] = code >= 0x20 && code <= 0x7e ? code : 0x20;
  }
}

/** True if all six callsign-char octets of a shifted field decode to spaces. */
function isAllSpaceBase(source: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 6; i++) {
    if (source[offset + i]! >> 1 !== 0x20) {
      return false;
    }
  }
  return true;
}
