/**
 * Test-only encoder for NET/ROM NODES-broadcast information fields. The
 * production library is strictly read-only (it parses heard broadcasts and never
 * originates one), so the tests bring their own byte builder to exercise the
 * parser and the routing table with realistic, spec-shaped input — encode here,
 * parse with `parseNodesBroadcast`, assert.
 *
 * The callsign fields use the genuine AX.25 shifted form via `writeAddress` —
 * the same codec the parser decodes with — so a round-trip proves the shift /
 * SSID handling, not a tautology against a hand-rolled encoder. Mirrors the C#
 * `tests/Packet.NetRom.Tests/NodesBroadcastBuilder.cs`.
 */
import { Callsign } from "../src/callsign.js";
import { ADDRESS_ENCODED_LENGTH, writeAddress } from "../src/address.js";
import {
  NODES_SIGNATURE,
  NETROM_ALIAS_LENGTH,
} from "../src/netrom/index.js";
import {
  ui,
  PID_NET_ROM,
  type Ax25Frame,
} from "../src/frame.js";

/** One destination entry to encode into a NODES dump. */
export interface NodesEntrySpec {
  dest: Callsign;
  destAlias: string;
  neighbour: Callsign;
  quality: number;
}

/** Encode a callsign in the 7-octet AX.25 shifted form. */
export function encodeShifted(call: Callsign): Uint8Array {
  const bytes = new Uint8Array(ADDRESS_ENCODED_LENGTH);
  writeAddress(bytes, 0, {
    callsign: call,
    crhBit: false,
    extensionBit: false,
  });
  return bytes;
}

/** Encode a 6-char alias as plain space-padded ASCII (truncated to 6). */
export function encodeAlias(alias: string): Uint8Array {
  const bytes = new Uint8Array(NETROM_ALIAS_LENGTH).fill(0x20);
  for (let i = 0; i < Math.min(alias.length, NETROM_ALIAS_LENGTH); i++) {
    bytes[i] = alias.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Build a NODES info field: 0xFF signature + 6-byte alias + the entries. */
export function buildNodesInfo(
  senderAlias: string,
  entries: NodesEntrySpec[] = [],
): Uint8Array {
  const parts: number[] = [NODES_SIGNATURE];
  parts.push(...encodeAlias(senderAlias));
  for (const e of entries) {
    parts.push(...encodeShifted(e.dest));
    parts.push(...encodeAlias(e.destAlias));
    parts.push(...encodeShifted(e.neighbour));
    parts.push(e.quality & 0xff);
  }
  return Uint8Array.from(parts);
}

/**
 * Build a genuine NODES broadcast UI frame: source = the broadcasting node,
 * destination = the literal text callsign "NODES", PID 0xCF. Used by the
 * service / read-only-guarantee tests to inject a real frame through the
 * listener's inbound pump.
 */
export function buildNodesFrame(
  source: Callsign,
  info: Uint8Array,
): Ax25Frame {
  return ui({
    destination: new Callsign(NODES_DESTINATION_BASE, 0),
    source,
    info,
    pid: PID_NET_ROM,
    isCommand: true,
  });
}

const NODES_DESTINATION_BASE = "NODES";
