import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { writeShifted } from "../../src/netrom/callsign.js";
import {
  INP3_HORIZON_MS,
  INP3_PARSE_BPQ,
  INP3_PARSE_LENIENT,
  INP3_PARSE_STRICT,
  INP3_PARSE_XROUTER,
  INP3_RIF_SIGNATURE,
  INP3_RIP_PREFIX_LENGTH,
  INP3_TLV_ALIAS_TYPE,
  INP3_TLV_IP_TYPE,
  type Inp3Rif,
  type Inp3Rip,
  inp3RifToBytes,
  inp3RipAlias,
  inp3RipIsHorizon,
  inp3RipToBytes,
  inp3TlvAlias,
  inp3TlvAsAlias,
  inp3TlvAsIpAddress,
  inp3TlvIp,
  inp3TlvIsKnown,
  parseInp3Rif,
  parseInp3Rip,
} from "../../src/netrom/inp3-rif.js";

/**
 * Vectors and totality tests for the INP3 RIF / RIP / TLV wire codec
 * ({@link Inp3Rif} / {@link Inp3Rip} / `Inp3Tlv`), against the locked byte
 * layouts in `docs/netrom-inp3-i1-wire-spec.md` §2.5–2.6 (packet.net). Every hex
 * vector in the spec is asserted here, including the unknown-TLV-retained,
 * alias/EOP, and horizon/withdrawal cases, plus round-trip and the totality
 * (never-throw) contract on garbage and truncation.
 *
 * Ported faithfully from `Packet.NetRom.Tests.Wire.Inp3RifTests` on the C# side.
 */
describe("inp3-rif", () => {
  const Gb7Rdg0 = new Callsign("GB7RDG", 0);
  const Gb7Rdg7 = new Callsign("GB7RDG", 7);
  const M0lte0 = new Callsign("M0LTE", 0);
  const Gb7Xyz0 = new Callsign("GB7XYZ", 0);

  function hex(s: string): Uint8Array {
    const tokens = s.split(/[\s]+/).filter((t) => t.length > 0);
    return Uint8Array.from(tokens.map((t) => parseInt(t, 16)));
  }

  function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
    expect(Array.from(actual)).toEqual(Array.from(expected));
  }

  // ─── Shifted-callsign sanity (the spec's stated shifted forms) ───

  it.each([
    ["GB7RDG", 0, "8E 84 6E A4 88 8E 60"],
    ["GB7RDG", 7, "8E 84 6E A4 88 8E 6E"],
    ["M0LTE", 0, "9A 60 98 A8 8A 40 60"],
    ["GB7XYZ", 0, "8E 84 6E B0 B2 B4 60"],
  ])("shifted callsign %s-%i matches the spec vector", (base, ssid, expectedHex) => {
    const buf = new Uint8Array(7);
    writeShifted(new Callsign(base as string, ssid as number), buf);
    expectBytes(buf, hex(expectedHex as string));
  });

  // ─── RIP single-entry vectors (§2.5) ───

  it("RIP-1 alias TLV parses and round-trips", () => {
    // 8E 84 6E A4 88 8E 60  02  00 2D  00 03 52 44 47  00
    const bytes = hex("8E 84 6E A4 88 8E 60 02 00 2D 00 03 52 44 47 00");
    expect(bytes.length).toBe(16);

    const result = parseInp3Rip(bytes);
    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(16);
    const rip = result!.rip;
    expect(rip.destination.equals(Gb7Rdg0)).toBe(true);
    expect(rip.hopCount).toBe(2);
    expect(rip.targetTimeMs).toBe(450);
    expect(inp3RipIsHorizon(rip)).toBe(false);
    expect(rip.tlvs).toHaveLength(1);
    expect(rip.tlvs[0]!.type).toBe(INP3_TLV_ALIAS_TYPE);
    expect(inp3TlvAsAlias(rip.tlvs[0]!)).toBe("RDG");
    expect(inp3RipAlias(rip)).toBe("RDG");

    expectBytes(inp3RipToBytes(rip), bytes);
  });

  it("RIP-2 IP TLV parses and round-trips", () => {
    // 9A 60 98 A8 8A 40 60  01  00 0C  01 04 2C 83 5B 02  00   (44.131.91.2)
    const bytes = hex("9A 60 98 A8 8A 40 60 01 00 0C 01 04 2C 83 5B 02 00");
    expect(bytes.length).toBe(17);

    const result = parseInp3Rip(bytes);
    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(17);
    const rip = result!.rip;
    expect(rip.destination.equals(M0lte0)).toBe(true);
    expect(rip.hopCount).toBe(1);
    expect(rip.targetTimeMs).toBe(120);
    expect(rip.tlvs).toHaveLength(1);
    expect(rip.tlvs[0]!.type).toBe(INP3_TLV_IP_TYPE);
    expect(inp3TlvAsIpAddress(rip.tlvs[0]!)).toBe("44.131.91.2");

    expectBytes(inp3RipToBytes(rip), bytes);
  });

  it("RIP-3 unknown TLV is retained verbatim and re-emitted", () => {
    // 8E 84 6E B0 B2 B4 60  04  00 FA  7F 02 AA BB  00 03 58 59 5A  00
    const bytes = hex(
      "8E 84 6E B0 B2 B4 60 04 00 FA 7F 02 AA BB 00 03 58 59 5A 00",
    );
    expect(bytes.length).toBe(20);

    const result = parseInp3Rip(bytes);
    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(20);
    const rip = result!.rip;
    expect(rip.destination.equals(Gb7Xyz0)).toBe(true);
    expect(rip.hopCount).toBe(4);
    expect(rip.targetTimeMs).toBe(2500);

    expect(rip.tlvs).toHaveLength(2);

    // The 0x7F TLV is unknown → retained verbatim, flagged not-known.
    const unknown = rip.tlvs[0]!;
    expect(unknown.type).toBe(0x7f);
    expect(inp3TlvIsKnown(unknown)).toBe(false);
    expectBytes(unknown.value, Uint8Array.from([0xaa, 0xbb]));

    // The alias TLV after the unknown one still decodes.
    expect(rip.tlvs[1]!.type).toBe(INP3_TLV_ALIAS_TYPE);
    expect(inp3TlvIsKnown(rip.tlvs[1]!)).toBe(true);
    expect(inp3RipAlias(rip)).toBe("XYZ");

    // Re-emission keeps the unknown TLV byte-for-byte.
    expectBytes(inp3RipToBytes(rip), bytes);
  });

  it("RIP-4 horizon withdrawal has no TLV and flags horizon", () => {
    // 8E 84 6E A4 88 8E 6E  FF  EA 60  00
    const bytes = hex("8E 84 6E A4 88 8E 6E FF EA 60 00");
    expect(bytes.length).toBe(11);

    const result = parseInp3Rip(bytes);
    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(11);
    const rip = result!.rip;
    expect(rip.destination.equals(Gb7Rdg7)).toBe(true);
    expect(rip.hopCount).toBe(0xff);
    expect(rip.targetTimeMs).toBe(INP3_HORIZON_MS);
    expect(rip.targetTimeMs).toBe(600_000);
    expect(inp3RipIsHorizon(rip)).toBe(true);
    expect(rip.tlvs).toHaveLength(0);
    expect(inp3RipAlias(rip)).toBeNull();

    expectBytes(inp3RipToBytes(rip), bytes);
  });

  // ─── RIF body vectors (§2.5) ───

  it("RIF-FULL parses all four RIPs in order", () => {
    const bytes = hex(
      "FF " +
        "8E 84 6E A4 88 8E 60 02 00 2D 00 03 52 44 47 00 " + // RIP-1
        "9A 60 98 A8 8A 40 60 01 00 0C 01 04 2C 83 5B 02 00 " + // RIP-2
        "8E 84 6E B0 B2 B4 60 04 00 FA 7F 02 AA BB 00 03 58 59 5A 00 " + // RIP-3
        "8E 84 6E A4 88 8E 6E FF EA 60 00", // RIP-4
    );
    expect(bytes.length).toBe(65); // 1 + 16 + 17 + 20 + 11

    const rif = parseInp3Rif(bytes, INP3_PARSE_STRICT);
    expect(rif).not.toBeNull();
    expect(rif!.rips).toHaveLength(4);

    expect(rif!.rips.map((r) => r.destination.toString())).toEqual([
      Gb7Rdg0.toString(),
      M0lte0.toString(),
      Gb7Xyz0.toString(),
      Gb7Rdg7.toString(),
    ]);
    expect(rif!.rips.map((r) => r.hopCount)).toEqual([2, 1, 4, 0xff]);
    expect(rif!.rips.map((r) => r.targetTimeMs)).toEqual([450, 120, 2500, 600_000]);

    expect(inp3RipAlias(rif!.rips[0]!)).toBe("RDG");
    expect(inp3TlvAsIpAddress(rif!.rips[1]!.tlvs[0]!)).toBe("44.131.91.2");
    expect(rif!.rips[2]!.tlvs[0]!.type).toBe(0x7f); // unknown retained
    expect(inp3RipAlias(rif!.rips[2]!)).toBe("XYZ");
    expect(inp3RipIsHorizon(rif!.rips[3]!)).toBe(true);

    // Round-trip the whole frame.
    expectBytes(inp3RifToBytes(rif!), bytes);
  });

  it("RIF-MIN signature plus one no-TLV RIP", () => {
    // FF  9A 60 98 A8 8A 40 60  01  00 7B  00
    const bytes = hex("FF 9A 60 98 A8 8A 40 60 01 00 7B 00");
    expect(bytes.length).toBe(12);

    const rif = parseInp3Rif(bytes, INP3_PARSE_STRICT);
    expect(rif).not.toBeNull();
    expect(rif!.rips).toHaveLength(1);
    const rip = rif!.rips[0]!;
    expect(rip.destination.equals(M0lte0)).toBe(true);
    expect(rip.hopCount).toBe(1);
    expect(rip.targetTimeMs).toBe(1230); // 0x7B = 123 units × 10 ms
    expect(rip.tlvs).toHaveLength(0);

    expectBytes(inp3RifToBytes(rif!), bytes);
  });

  // ─── Builder-side round-trip (parser is the oracle) ───

  it("built RIF round-trips through the parser", () => {
    const rif: Inp3Rif = {
      rips: [
        {
          destination: Gb7Rdg0,
          hopCount: 2,
          targetTimeMs: 450,
          tlvs: [inp3TlvAlias("RDG")],
        },
        {
          destination: M0lte0,
          hopCount: 1,
          targetTimeMs: 120,
          tlvs: [inp3TlvIp(Uint8Array.from([0x2c, 0x83, 0x5b, 0x02]))],
        },
        {
          destination: Gb7Rdg7,
          hopCount: 0xff,
          targetTimeMs: INP3_HORIZON_MS,
          tlvs: [],
        },
      ],
    };

    const bytes = inp3RifToBytes(rif);

    const parsed = parseInp3Rif(bytes, INP3_PARSE_STRICT);
    expect(parsed).not.toBeNull();
    expect(parsed!.rips).toHaveLength(3);
    expect(inp3RipAlias(parsed!.rips[0]!)).toBe("RDG");
    expect(inp3TlvAsIpAddress(parsed!.rips[1]!.tlvs[0]!)).toBe("44.131.91.2");
    expect(inp3RipIsHorizon(parsed!.rips[2]!)).toBe(true);
    expectBytes(inp3RifToBytes(parsed!), bytes);
  });

  it("IPv6 TLV round-trips", () => {
    // 2001:db8::1
    const v6 = Uint8Array.from([
      0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const rip: Inp3Rip = {
      destination: M0lte0,
      hopCount: 1,
      targetTimeMs: 100,
      tlvs: [inp3TlvIp(v6)],
    };

    const bytes = inp3RipToBytes(rip);
    const result = parseInp3Rip(bytes);
    expect(result).not.toBeNull();
    expect(result!.rip.tlvs[0]!.value.length).toBe(16);
    expect(inp3TlvAsIpAddress(result!.rip.tlvs[0]!)).toBe("2001:db8::1");
  });

  // ─── Empty-list preset gating (§2.6, mirrors NODES) ───

  it("signature-only RIF is rejected by strict but accepted by lenient", () => {
    const bytes = hex("FF"); // signature, zero RIPs

    expect(parseInp3Rif(bytes, INP3_PARSE_STRICT)).toBeNull();

    const lenient = parseInp3Rif(bytes, INP3_PARSE_LENIENT);
    expect(lenient).not.toBeNull();
    expect(lenient!.rips).toHaveLength(0);
  });

  it("BPQ and XRouter presets accept signature-only like lenient", () => {
    const bytes = hex("FF");
    const bpq = parseInp3Rif(bytes, INP3_PARSE_BPQ);
    expect(bpq).not.toBeNull();
    expect(bpq!.rips).toHaveLength(0);
    const xr = parseInp3Rif(bytes, INP3_PARSE_XROUTER);
    expect(xr).not.toBeNull();
    expect(xr!.rips).toHaveLength(0);
  });

  // ─── Trailing-partial RIP gating (§2.6) ───

  it("RIP truncated mid-target-time is rejected by strict, dropped by lenient", () => {
    // FF + a clean RIP-MIN body, then a second RIP clipped after 2 octets of its prefix.
    const clean = hex("FF 9A 60 98 A8 8A 40 60 01 00 7B 00");
    const partial = hex("8E 84 6E A4 88 8E 60 02 00"); // partial RIP-2
    const clipped = Uint8Array.from([...clean, ...partial]);

    // Strict: the leftover that doesn't complete a RIP rejects the whole frame.
    expect(parseInp3Rif(clipped, INP3_PARSE_STRICT)).toBeNull();

    // Lenient: keep the whole RIP parsed, drop the clipped tail.
    const lenient = parseInp3Rif(clipped, INP3_PARSE_LENIENT);
    expect(lenient).not.toBeNull();
    expect(lenient!.rips).toHaveLength(1);
    expect(lenient!.rips[0]!.destination.equals(M0lte0)).toBe(true);
  });

  it("truncated trailing alias TLV degrades to EOP keeping the route", () => {
    // FF + a RIP whose trailing bytes look like an alias TLV (00 03 ...) but claim
    // more value bytes than remain (len=3, only "RD" present).
    const bytes = hex("FF 8E 84 6E A4 88 8E 60 02 00 2D 00 03 52 44");

    // The alias TLV type (0x00) is identical to the EOP byte (AMBIGUITY-RIF-2),
    // so a 0x00 that cannot be satisfied as a TLV is *necessarily* read as the
    // EOP — this is the same rule that lets a multi-RIP RIF find its boundaries.
    // The RIP therefore keeps its routing fields (450 ms) and simply drops the
    // malformed trailing alias; the leftover bytes are a trailing partial.

    // Strict: the leftover (03 52 44) is an un-frameable trailing partial → reject.
    expect(parseInp3Rif(bytes, INP3_PARSE_STRICT)).toBeNull();

    // Lenient: the leftover partial is dropped; the one whole RIP survives, sans alias.
    const lenient = parseInp3Rif(bytes, INP3_PARSE_LENIENT);
    expect(lenient).not.toBeNull();
    expect(lenient!.rips).toHaveLength(1);
    expect(lenient!.rips[0]!.targetTimeMs).toBe(450);
    // The malformed trailing alias was read as EOP and dropped.
    expect(inp3RipAlias(lenient!.rips[0]!)).toBeNull();
  });

  it("a target time above the horizon is flagged unreachable", () => {
    // Max encodable target time 0xFFFF = 655350 ms — above the 600 000 ms horizon,
    // so still a withdrawal. (RIP-4 covers exactly-horizon; this covers above it.)
    const bytes = hex("FF 9A 60 98 A8 8A 40 60 01 FF FF 00");
    const rif = parseInp3Rif(bytes);
    expect(rif).not.toBeNull();
    expect(rif!.rips).toHaveLength(1);
    expect(rif!.rips[0]!.targetTimeMs).toBe(655350);
    // Any target time at/above 600 s is unreachable.
    expect(inp3RipIsHorizon(rif!.rips[0]!)).toBe(true);
  });

  // ─── Wrong / missing signature (§2.6) ───

  it("empty input returns null", () => {
    expect(parseInp3Rif(new Uint8Array(0))).toBeNull();
  });

  it("wrong signature returns null", () => {
    // Same bytes as RIF-MIN but signature 0x00 instead of 0xFF.
    const bytes = hex("00 9A 60 98 A8 8A 40 60 01 00 7B 00");
    expect(parseInp3Rif(bytes)).toBeNull();
  });

  it("RIP with bad callsign field fails to parse", () => {
    // A 7-octet callsign slot with a non-space byte after a space pad does not
    // decode (tryReadShifted → null). An all-zero prefix decodes 0x00 chars which
    // are not A-Z/0-9 once unshifted, so callsign decode fails first.
    const bytes = new Uint8Array(INP3_RIP_PREFIX_LENGTH + 1); // garbage prefix + a byte
    const result = parseInp3Rip(bytes);
    expect(result).toBeNull();
  });

  // ─── Totality: arbitrary / truncated bytes never throw (§0 contract) ───

  it.each([[0], [1], [2], [10], [11], [15], [64]])(
    "short or truncated input of length %i never throws",
    (length) => {
      const bytes = new Uint8Array(length as number);
      if ((length as number) > 0) bytes[0] = INP3_RIF_SIGNATURE;

      expect(() => {
        parseInp3Rif(bytes);
        parseInp3Rif(bytes, INP3_PARSE_STRICT);
      }).not.toThrow();
    },
  );

  it("truncations of every full-RIF prefix never throw and never over-read", () => {
    const full = hex(
      "FF 8E 84 6E A4 88 8E 60 02 00 2D 00 03 52 44 47 00 " +
        "9A 60 98 A8 8A 40 60 01 00 0C 01 04 2C 83 5B 02 00 " +
        "8E 84 6E B0 B2 B4 60 04 00 FA 7F 02 AA BB 00 03 58 59 5A 00 " +
        "8E 84 6E A4 88 8E 6E FF EA 60 00",
    );

    for (let n = 0; n <= full.length; n++) {
      const prefix = full.slice(0, n);
      expect(() => parseInp3Rif(prefix, INP3_PARSE_LENIENT)).not.toThrow();
      expect(() => parseInp3Rif(prefix, INP3_PARSE_STRICT)).not.toThrow();
    }
  });

  it("random garbage never throws", () => {
    const rng = makeRng(20260607);
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(rng(0, 400));
      for (let j = 0; j < bytes.length; j++) bytes[j] = rng(0, 256);

      expect(() => {
        parseInp3Rif(bytes, INP3_PARSE_LENIENT);
        parseInp3Rif(bytes, INP3_PARSE_STRICT);
        parseInp3Rip(bytes);
      }).not.toThrow();
    }
  });

  it("random signature-prefixed garbage never throws", () => {
    // Bias toward 0xFF-signed bodies so the RIP walker is exercised on junk.
    const rng = makeRng(424242);
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(rng(1, 200));
      for (let j = 0; j < bytes.length; j++) bytes[j] = rng(0, 256);
      bytes[0] = INP3_RIF_SIGNATURE;

      expect(() => {
        parseInp3Rif(bytes, INP3_PARSE_LENIENT);
        parseInp3Rif(bytes, INP3_PARSE_STRICT);
      }).not.toThrow();
    }
  });
});

/**
 * A tiny deterministic PRNG (mulberry32) so the fuzz vectors are reproducible —
 * the TS analogue of the C# `new Random(seed)` the ported tests use. Returns an
 * integer in `[min, max)`.
 */
function makeRng(seed: number): (min: number, max: number) => number {
  let a = seed >>> 0;
  return (min: number, max: number) => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(r * (max - min));
  };
}
