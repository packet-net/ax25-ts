/**
 * NET/ROM route-quality arithmetic — TS port of
 * `tests/Packet.NetRom.Tests/Routing/NetRomQualityTests.cs`. The worked examples
 * are the ones in `/home/tf/netrom-research.md` (a 200-quality direct link is
 * ≈ 156 at two hops, ≈ 78 at three).
 */
import { describe, expect, it } from "vitest";
import {
  NETROM_QUALITY_MAX,
  NETROM_QUALITY_MIN,
  combineQuality,
} from "../../src/netrom/index.js";

describe("combineQuality — canonical formula (a*b + 128) / 256", () => {
  it.each([
    [255, 255, 254], // best × best
    [0, 200, 0], // zero advertised → zero
    [200, 0, 0], // zero path → zero
    [192, 192, 144], // 36864 + 128 = 36992 / 256 = 144.5 → 144
    [128, 128, 64], // 16384 + 128 = 16512 / 256 = 64.5 → 64
  ])("combine(%i, %i) === %i", (bq, pq, expected) => {
    expect(combineQuality(bq, pq)).toBe(expected);
  });

  it("worked example: two hops of a 200-quality link is about 156", () => {
    // (200*200 + 128) / 256 = 40128 / 256 = 156.75 → 156.
    expect(combineQuality(200, 200)).toBe(156);
  });

  it("worked example: three hops (last link 128) is about 78", () => {
    // The two-hop value (156) combined with a 128 link:
    // (156*128 + 128) / 256 = 19968 / 256 = 78.
    const twoHop = combineQuality(200, 200); // 156
    expect(combineQuality(twoHop, 128)).toBe(78);
  });

  it("is monotonic — quality never increases with an extra hop", () => {
    // A hop can only attenuate: for any path quality < 255 (not a perfect link),
    // combining reduces the advertised quality. This is the loop-safety
    // invariant — quality decreases per hop.
    for (let bq = 1; bq <= 255; bq++) {
      for (let pq = 1; pq < 255; pq++) {
        expect(combineQuality(bq, pq)).toBeLessThanOrEqual(bq);
      }
    }
  });

  it("result is always a valid byte (0..255)", () => {
    for (let bq = 0; bq <= 255; bq++) {
      for (let pq = 0; pq <= 255; pq++) {
        const q = combineQuality(bq, pq);
        expect(q).toBeGreaterThanOrEqual(NETROM_QUALITY_MIN);
        expect(q).toBeLessThanOrEqual(NETROM_QUALITY_MAX);
      }
    }
  });
});
