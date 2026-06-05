/**
 * Tests for the L3-origination NODES builder (`buildNodesBroadcast`) — TS port of
 * `tests/Packet.NetRom.Tests/Wire/NodesBroadcastBuilderTests.cs`.
 *
 * The bytes it emits must parse back through the production `parseNodesBroadcast`
 * parser to the same entries (the parser is the oracle — no hand-rolled-encoder
 * tautology), a table larger than 11 entries must chunk into multiple frames, and
 * an empty table must emit a single header-only frame. The build→parse case is
 * also the builder↔parser inverse (round-trip parity) check.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  buildNodesBroadcast,
  NETROM_ALIAS_LENGTH,
  NETROM_SHIFTED_LENGTH,
  NODES_ENTRY_ENCODED_LENGTH,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_SIGNATURE,
  NETROM_PARSE_STRICT,
  parseNodesBroadcast,
  type NodesBroadcastEntry,
} from "../../src/netrom/index.js";

function entry(
  dest: string,
  alias: string,
  via: string,
  q: number,
): NodesBroadcastEntry {
  return {
    destination: new Callsign(dest),
    destinationAlias: alias,
    bestNeighbour: new Callsign(via),
    quality: q,
  };
}

describe("buildNodesBroadcast — build then parse (round-trip parity)", () => {
  it("round-trips the entries through the production parser", () => {
    // Mirrors C# Build_then_parse_round_trips_the_entries.
    const entries = [
      entry("GB7SOT", "SOT", "GB7XYZ", 200),
      entry("GB7PYB", "PYB", "GB7XYZ", 156),
    ];

    const frames = buildNodesBroadcast("RDGBPQ", entries);
    expect(frames).toHaveLength(1);

    // Parse with the existing parser (the inverse of the builder), strictly.
    const parsed = parseNodesBroadcast(frames[0]!, NETROM_PARSE_STRICT);
    expect(parsed).not.toBeNull();
    expect(parsed!.senderAlias).toBe("RDGBPQ");
    expect(parsed!.entries).toHaveLength(2);
    expect(parsed!.entries[0]!.destination.equals(new Callsign("GB7SOT"))).toBe(true);
    expect(parsed!.entries[0]!.destinationAlias).toBe("SOT");
    expect(parsed!.entries[0]!.bestNeighbour.equals(new Callsign("GB7XYZ"))).toBe(true);
    expect(parsed!.entries[0]!.bestQuality).toBe(200);
    expect(parsed!.entries[1]!.destination.equals(new Callsign("GB7PYB"))).toBe(true);
    expect(parsed!.entries[1]!.bestQuality).toBe(156);
  });

  it("preserves an SSID-bearing callsign through the shifted round-trip", () => {
    const entries = [entry("GB7XYZ", "XYZ", "GB7XYZ", 192)];
    entries[0] = {
      ...entries[0]!,
      bestNeighbour: new Callsign("GB7XYZ", 5),
    };
    const parsed = parseNodesBroadcast(
      buildNodesBroadcast("RDGBPQ", entries)[0]!,
      NETROM_PARSE_STRICT,
    );
    expect(parsed!.entries[0]!.bestNeighbour.toString()).toBe("GB7XYZ-5");
  });
});

describe("buildNodesBroadcast — framing", () => {
  it("emits a single header-only frame for an empty table", () => {
    // Mirrors C# Empty_table_emits_a_single_header_only_frame.
    const frames = buildNodesBroadcast("RDGBPQ", []);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(7); // 0xFF signature + 6-byte alias, no entries

    // The lenient parser accepts a header-only broadcast (a node announcing itself).
    const parsed = parseNodesBroadcast(frames[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed!.senderAlias).toBe("RDGBPQ");
    expect(parsed!.entries).toHaveLength(0);
  });

  it("defaults to a header-only frame when entries are omitted", () => {
    const frames = buildNodesBroadcast("RDGBPQ");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(7);
  });

  it("chunks a table over 11 entries into multiple frames", () => {
    // Mirrors C# A_table_over_11_entries_chunks_into_multiple_frames.
    // 25 destinations → 11 + 11 + 3 = 3 frames.
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry(
        `GB7N${String(i).padStart(2, "0")}`,
        `N${String(i).padStart(2, "0")}`,
        "GB7HUB",
        200 - i,
      ),
    );

    const frames = buildNodesBroadcast("HUBBPQ", entries);
    expect(frames).toHaveLength(3);

    const reassembled: string[] = [];
    for (const frame of frames) {
      const parsed = parseNodesBroadcast(frame, NETROM_PARSE_STRICT);
      expect(parsed).not.toBeNull();
      expect(parsed!.entries.length).toBeLessThanOrEqual(
        NODES_MAX_ENTRIES_PER_FRAME,
      );
      reassembled.push(...parsed!.entries.map((e) => e.destination.toString()));
    }

    expect(reassembled).toHaveLength(25);
    expect(reassembled).toEqual(entries.map((e) => e.destination.toString()));
  });

  it("packs exactly 11 entries into a single frame at the boundary", () => {
    const entries = Array.from({ length: 11 }, (_, i) =>
      entry("GB7SOT", "SOT", "GB7XYZ", 200 - i),
    );
    const frames = buildNodesBroadcast("RDGBPQ", entries);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(7 + 11 * NODES_ENTRY_ENCODED_LENGTH);
  });
});

describe("buildNodesBroadcast — byte layout", () => {
  it("carries the signature and is a dest-NODES-ready frame", () => {
    // Mirrors C# Built_frames_carry_the_signature_and_are_dest_NODES_ready.
    const frames = buildNodesBroadcast("RDGBPQ", [
      entry("GB7SOT", "SOT", "GB7XYZ", 200),
    ]);
    expect(frames[0]![0]).toBe(NODES_SIGNATURE);
    // 0xFF + 6 alias + one 21-byte entry.
    expect(frames[0]!.length).toBe(7 + 21);
  });

  it("lays out a known entry byte-for-byte (header + shifted/alias/quality)", () => {
    // GB7SOT shifted = each char << 1, SSID byte 0x60 (R=11, SSID 0, E=0, C=0).
    const dest = new Callsign("GB7SOT", 0);
    const via = new Callsign("GB7XYZ", 0);
    const frame = buildNodesBroadcast("RDG", [entry("GB7SOT", "SOT", "GB7XYZ", 200)])[0]!;

    // Header: 0xFF + "RDG" padded to 6 with spaces.
    expect(frame[0]).toBe(0xff);
    expect(Array.from(frame.slice(1, 7))).toEqual([
      "R".charCodeAt(0),
      "D".charCodeAt(0),
      "G".charCodeAt(0),
      0x20,
      0x20,
      0x20,
    ]);

    // Entry destination callsign: chars left-shifted by one.
    const destField = frame.slice(7, 7 + NETROM_SHIFTED_LENGTH);
    expect(Array.from(destField.slice(0, 6))).toEqual(
      [..."GB7SOT"].map((c) => (c.charCodeAt(0) << 1) & 0xff),
    );
    expect(destField[6]).toBe(0x60); // R=11, SSID=0, C/H=0, E=0

    // Entry destination alias: "SOT" padded to 6 with spaces, no shift.
    const aliasOff = 7 + NETROM_SHIFTED_LENGTH;
    expect(Array.from(frame.slice(aliasOff, aliasOff + NETROM_ALIAS_LENGTH))).toEqual([
      "S".charCodeAt(0),
      "O".charCodeAt(0),
      "T".charCodeAt(0),
      0x20,
      0x20,
      0x20,
    ]);

    // Best-neighbour callsign GB7XYZ, then the quality byte last.
    const viaOff = aliasOff + NETROM_ALIAS_LENGTH;
    expect(Array.from(frame.slice(viaOff, viaOff + 6))).toEqual(
      [..."GB7XYZ"].map((c) => (c.charCodeAt(0) << 1) & 0xff),
    );
    expect(frame[7 + NODES_ENTRY_ENCODED_LENGTH - 1]).toBe(200);

    // Sanity: it parses back to the same callsigns.
    const parsed = parseNodesBroadcast(frame, NETROM_PARSE_STRICT)!;
    expect(parsed.entries[0]!.destination.equals(dest)).toBe(true);
    expect(parsed.entries[0]!.bestNeighbour.equals(via)).toBe(true);
  });
});
