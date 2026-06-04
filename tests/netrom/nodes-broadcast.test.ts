/**
 * Parser totality + strict/lenient pairs for the NET/ROM NODES-broadcast wire
 * codec — TS port of `tests/Packet.NetRom.Tests/Wire/NodesBroadcastParseTests.cs`.
 *
 * The production library is read-only, so the tests own the encoder
 * (`tests/netrom-builder.ts`). The "spec-compliant by default, pragmatism is a
 * named flag" discipline carries over: every leniency has a paired
 * strict-rejects / lenient-accepts assertion.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NETROM_PARSE_BPQ,
  NETROM_PARSE_LENIENT,
  NETROM_PARSE_STRICT,
  NETROM_PARSE_XROUTER,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_SIGNATURE,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { buildNodesInfo } from "../netrom-builder.js";

const Gb7Rdg = new Callsign("GB7RDG", 0);
const Gb7Sot = new Callsign("GB7SOT", 0);
const Gb7Xyz = new Callsign("GB7XYZ", 5);

describe("parseNodesBroadcast — fields", () => {
  it("parses signature and sender alias", () => {
    const bc = parseNodesBroadcast(buildNodesInfo("RDGBPQ"));
    expect(bc).not.toBeNull();
    expect(bc!.senderAlias).toBe("RDGBPQ");
    expect(bc!.entries).toHaveLength(0);
  });

  it("rejects a frame whose first octet is not the signature", () => {
    const info = buildNodesInfo("RDGBPQ");
    info[0] = 0x00; // canonical "wrong signature → ignore"
    expect(parseNodesBroadcast(info)).toBeNull();
  });

  it("parses a single destination entry with all fields", () => {
    const bc = parseNodesBroadcast(
      buildNodesInfo("RDGBPQ", [
        { dest: Gb7Sot, destAlias: "SOT", neighbour: Gb7Xyz, quality: 200 },
      ]),
    );
    expect(bc).not.toBeNull();
    expect(bc!.entries).toHaveLength(1);
    const e = bc!.entries[0]!;
    expect(e.destination.equals(Gb7Sot)).toBe(true);
    expect(e.destinationAlias).toBe("SOT");
    expect(e.bestNeighbour.equals(Gb7Xyz)).toBe(true); // SSID 5 survives the shifted round-trip
    expect(e.bestQuality).toBe(200);
  });

  it("parses several entries in order", () => {
    const bc = parseNodesBroadcast(
      buildNodesInfo("RDGBPQ", [
        { dest: Gb7Sot, destAlias: "SOT", neighbour: Gb7Xyz, quality: 200 },
        { dest: Gb7Xyz, destAlias: "XYZ", neighbour: Gb7Xyz, quality: 192 },
        { dest: Gb7Rdg, destAlias: "RDG", neighbour: Gb7Rdg, quality: 255 },
      ]),
    );
    expect(bc).not.toBeNull();
    expect(bc!.entries).toHaveLength(3);
    expect(bc!.entries.map((e) => e.destination.toString())).toEqual([
      "GB7SOT",
      "GB7XYZ-5",
      "GB7RDG",
    ]);
    expect(bc!.entries.map((e) => e.bestQuality)).toEqual([200, 192, 255]);
  });

  it("caps at eleven entries per frame, ignoring the surplus", () => {
    // Hand-build 13 entries; the canonical format caps a frame at 11.
    const entries = Array.from({ length: 13 }, () => ({
      dest: Gb7Sot,
      destAlias: "SOT",
      neighbour: Gb7Xyz,
      quality: 200,
    }));
    const bc = parseNodesBroadcast(buildNodesInfo("RDGBPQ", entries));
    expect(bc).not.toBeNull();
    expect(bc!.entries).toHaveLength(NODES_MAX_ENTRIES_PER_FRAME);
  });

  it("trims the sender alias of trailing spaces", () => {
    // "RDG" packed into a 6-byte field is "RDG   "; the parser trims it.
    const bc = parseNodesBroadcast(buildNodesInfo("RDG"));
    expect(bc).not.toBeNull();
    expect(bc!.senderAlias).toBe("RDG");
  });
});

describe("parseNodesBroadcast — strict-vs-lenient pairs", () => {
  it("trailing partial entry: rejected by strict, accepted by lenient", () => {
    const base = buildNodesInfo("RDGBPQ", [
      { dest: Gb7Sot, destAlias: "SOT", neighbour: Gb7Xyz, quality: 200 },
    ]);
    const info = Uint8Array.from([...base, 0x01, 0x02, 0x03]); // 3 trailing octets (< 21)

    expect(parseNodesBroadcast(info, NETROM_PARSE_STRICT)).toBeNull();

    const lenient = parseNodesBroadcast(info, NETROM_PARSE_LENIENT);
    expect(lenient).not.toBeNull();
    expect(lenient!.entries).toHaveLength(1); // the whole entry is kept; the remainder dropped
  });

  it("empty destination list: rejected by strict, accepted by lenient", () => {
    const info = buildNodesInfo("RDGBPQ"); // header only

    expect(parseNodesBroadcast(info, NETROM_PARSE_STRICT)).toBeNull();

    const lenient = parseNodesBroadcast(info, NETROM_PARSE_LENIENT);
    expect(lenient).not.toBeNull();
    expect(lenient!.entries).toHaveLength(0);
  });

  it("Bpq and Xrouter presets accept a padded dump like lenient", () => {
    const base = buildNodesInfo("RDGBPQ", [
      { dest: Gb7Sot, destAlias: "SOT", neighbour: Gb7Xyz, quality: 200 },
    ]);
    const info = Uint8Array.from([...base, 0x00]); // one pad octet on the final frame

    const bpq = parseNodesBroadcast(info, NETROM_PARSE_BPQ);
    expect(bpq).not.toBeNull();
    expect(bpq!.entries).toHaveLength(1);

    const xr = parseNodesBroadcast(info, NETROM_PARSE_XROUTER);
    expect(xr).not.toBeNull();
    expect(xr!.entries).toHaveLength(1);
  });
});

describe("parseNodesBroadcast — totality (arbitrary bytes never throw)", () => {
  it.each([0, 1, 6, 7, 20])(
    "short or truncated input (length %i) returns null without throwing",
    (length) => {
      const bytes = new Uint8Array(length);
      if (length > 0) bytes[0] = NODES_SIGNATURE;
      expect(() => parseNodesBroadcast(bytes)).not.toThrow();
    },
  );

  it("random garbage never throws", () => {
    // A small deterministic LCG so the run is reproducible (mirrors the C#
    // `new Random(1234)` seed intent).
    let seed = 1234;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      const len = next() % 300;
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j++) bytes[j] = next() & 0xff;
      expect(() => parseNodesBroadcast(bytes, NETROM_PARSE_LENIENT)).not.toThrow();
    }
  });

  it("an all-space best-neighbour field decodes to an empty-base callsign (lenient codec)", () => {
    // Some nodes pad an absent best-neighbour slot all-spaces. The strict
    // AX.25 address codec would reject it; the NET/ROM lenient codec recovers
    // it as a blank-base callsign rather than dropping the entry.
    const base = buildNodesInfo("RDGBPQ", [
      { dest: Gb7Sot, destAlias: "SOT", neighbour: new Callsign("", 0), quality: 200 },
    ]);
    const bc = parseNodesBroadcast(base);
    expect(bc).not.toBeNull();
    expect(bc!.entries).toHaveLength(1);
    expect(bc!.entries[0]!.bestNeighbour.base).toBe("");
  });
});
