/**
 * Tests for the INP3 SNTT integer IIR smoother ({@link Inp3Sntt}) — TS port of
 * `tests/Packet.NetRom.Tests/Routing/Inp3SnttTests.cs`. The worked convergence
 * trajectories are taken verbatim from `docs/netrom-inp3-i2-design.md` §0.5 and
 * are shared cross-stack golden vectors: the same `(seed, sample…)` sequence must
 * produce the same SNTT trajectory in C#, `@packet-net/ax25` (TS), and pico-node
 * (Rust). The C# reference smoother is authoritative; TS mirrors its integer
 * arithmetic 1:1 (no floating point anywhere — the shift-and-add form is exact
 * and language-agnostic, design §7).
 */
import { describe, expect, it } from "vitest";
import {
  Inp3Sntt,
  SNTT_DEFAULT_GAIN_SHIFT,
  SNTT_MAX_GAIN_SHIFT,
  SNTT_MIN_GAIN_SHIFT,
  SNTT_SAMPLE_MAX_MS,
  SNTT_UNSET,
} from "../../src/netrom/inp3-sntt.js";

describe("Inp3Sntt — integer IIR SNTT smoother", () => {
  // ── first-sample seeding (§0.2) ───────────────────────────────────────

  it("Fresh is uninitialised and reads unset", () => {
    const s = Inp3Sntt.fresh();
    expect(s.initialised).toBe(false);
    expect(s.ms).toBe(SNTT_UNSET);
    expect(s.value).toBeNull();
  });

  it("first sample seeds the filter directly with no smoothing", () => {
    // The first valid sample seeds SNTT := sample (canonical SRT/Karn). Were it
    // smoothed against a 0 seed it would read ~25 ((7*0+200+4)/8), not 200.
    const s = Inp3Sntt.fresh().update(200);
    expect(s.initialised).toBe(true);
    expect(s.ms).toBe(200);
    expect(s.value).toBe(200);
  });

  it("first sample of zero seeds a real zero distinct from unset", () => {
    // A same-host loopback can legitimately measure ~0; the Unset sentinel must
    // be distinct from a genuine 0 ms measurement.
    const s = Inp3Sntt.fresh().update(0);
    expect(s.initialised).toBe(true);
    expect(s.ms).toBe(0);
    expect(s.value).toBe(0);
    expect(s.ms).not.toBe(SNTT_UNSET);
  });

  it("seed factory is equivalent to fresh then update", () => {
    expect(Inp3Sntt.seed(200).equals(Inp3Sntt.fresh().update(200))).toBe(true);
    expect(Inp3Sntt.seed(0).equals(Inp3Sntt.fresh().update(0))).toBe(true);
  });

  // ── worked convergence example A — steady link (§0.5) ─────────────────

  it("example A: a steady link sits exactly on its fixed point", () => {
    // RTT steady at 400 ms ⇒ sample 200. Seed = 200; every subsequent
    // (7·200 + 200 + 4)/8 = 1604/8 = 200 — the +4 round-to-nearest keeps a
    // steady input pinned on its fixed point, no drift.
    let s = Inp3Sntt.seed(200);
    expect(s.ms).toBe(200);
    for (let i = 0; i < 100; i++) {
      s = s.update(200);
      // a steady sample reproduces itself exactly
      expect(s.ms).toBe(200);
    }
  });

  it("example B: step up then settle matches the design trajectory", () => {
    // A link that got slower: RTT jumps 100 → 1000 ms (sample 50 → 500).
    // Design §0.5 table B: seed 50, then 50, 106, 155, 198, 236.
    let s = Inp3Sntt.seed(50); // step 1 (seed)
    expect(s.ms).toBe(50);

    s = s.update(50); // step 2: (7·50+50+4)/8 = 404/8 = 50
    expect(s.ms).toBe(50);

    s = s.update(500); // step 3: (7·50+500+4)/8 = 854/8 = 106
    expect(s.ms).toBe(106);

    s = s.update(500); // step 4: (7·106+500+4)/8 = 1246/8 = 155
    expect(s.ms).toBe(155);

    s = s.update(500); // step 5: (7·155+500+4)/8 = 1589/8 = 198
    expect(s.ms).toBe(198);

    s = s.update(500); // step 6: (7·198+500+4)/8 = 1890/8 = 236
    expect(s.ms).toBe(236);
  });

  it("example B: converges toward the new sample over many probes", () => {
    // A sustained slowdown is fully reflected within a few probe intervals: a
    // 1/8-gain EWMA reaches ~95% of a step in ~24 samples. With integer rounding
    // the fixed-point region for sample 500 is [497, 500]; assert it converges to
    // within 3 ms of the new sample and never overshoots it.
    let s = Inp3Sntt.seed(50).update(50); // steady at 50
    for (let i = 0; i < 60; i++) {
      s = s.update(500);
      // the filter approaches a step from below, never overshooting
      expect(s.ms).toBeLessThanOrEqual(500);
    }
    // a 1/8 IIR settles onto the integer fixed-point band of its input
    expect(s.ms).toBeGreaterThanOrEqual(497);
    expect(s.ms).toBeLessThanOrEqual(500);
  });

  // ── worked convergence example C — outlier rejection (§0.5) ───────────

  it("example C: a single outlier is damped then walked back", () => {
    // Steady 200 ms RTT ⇒ sample 100, with one 2000 ms spike ⇒ sample 1000.
    // Design §0.5 table C: seed 100, then 100, 213, 199, 187, 176, 167.
    let s = Inp3Sntt.seed(100); // step 1 (seed)
    expect(s.ms).toBe(100);

    s = s.update(100); // step 2: (7·100+100+4)/8 = 804/8 = 100
    expect(s.ms).toBe(100);

    // step 3 (spike): (7·100+1000+4)/8 = 1704/8 = 213 — a lone 10× spike moves
    // SNTT by only +113, not to 1000 (the outlier rejection the smoother exists for)
    s = s.update(1000);
    expect(s.ms).toBe(213);

    s = s.update(100); // step 4: (7·213+100+4)/8 = 1595/8 = 199
    expect(s.ms).toBe(199);

    s = s.update(100); // step 5: (7·199+100+4)/8 = 1497/8 = 187
    expect(s.ms).toBe(187);

    s = s.update(100); // step 6: (7·187+100+4)/8 = 1413/8 = 176
    expect(s.ms).toBe(176);

    s = s.update(100); // step 7: (7·176+100+4)/8 = 1336/8 = 167
    expect(s.ms).toBe(167);
  });

  it("example C: walks back into the band of the true value after a spike", () => {
    // After the spike, the filter walks back to the true 100 within a handful of
    // probes. It rests in the integer rounding band [100, 104] rather than exactly
    // 100: descending from the spike it settles on the upper fixed point (104),
    // because the round-to-nearest +denom/2 term gives the integer IIR a small DC
    // bias (the same artifact AX.25 SRT carries). The point is the 10x outlier
    // leaves only a few ms of residue, not 100+.
    let s = Inp3Sntt.seed(100).update(100).update(1000); // post-spike = 213
    for (let i = 0; i < 100; i++) {
      s = s.update(100);
    }
    // the outlier residue decays into the rounding band of the true input
    expect(s.ms).toBeGreaterThanOrEqual(100);
    expect(s.ms).toBeLessThanOrEqual(104);
  });

  // ── monotonic-toward-sample (§0.1 one-pole low-pass) ──────────────────

  it("update moves strictly toward the sample when above current", () => {
    // A one-pole low-pass: SNTT' = SNTT + (sample - SNTT)/8. With sample > SNTT
    // the result is strictly between the old value and the sample (it moves
    // toward the sample, never past it).
    let s = Inp3Sntt.seed(100);
    for (let i = 0; i < 30; i++) {
      const before = s.ms;
      s = s.update(1000);
      expect(s.ms).toBeGreaterThan(before); // SNTT rises toward a larger sample
      expect(s.ms).toBeLessThanOrEqual(1000); // but never past the sample
    }
  });

  it("update moves strictly toward the sample when below current", () => {
    let s = Inp3Sntt.seed(1000);
    for (let i = 0; i < 30; i++) {
      const before = s.ms;
      s = s.update(0);
      expect(s.ms).toBeLessThan(before); // SNTT falls monotonically toward a smaller sample
      // floors at the sample band — never negative.
    }
    // Run to the fixed point: a steady 0 sample settles in the integer rounding
    // band [0, denom/2] (~4 at the default 1/8 gain), not exactly 0 — the same
    // round-to-nearest +denom/2 DC bias as Example C. The invariant is convergence
    // into that band, not exact 0.
    for (let i = 0; i < 100; i++) {
      s = s.update(0);
    }
    // a steady 0 sample converges into the rounding band, not exactly 0
    expect(s.ms).toBeGreaterThanOrEqual(0);
    expect(s.ms).toBeLessThanOrEqual(4);
  });

  it.each([
    [0, 1000], // rise from a low seed
    [1000, 0], // fall from a high seed
    [50, 500], // example-B shape
    [1000, 100], // example-C walk-back shape
  ])(
    "a smoothed value always lies between its previous value and the sample (seed %i, sample %i)",
    (seed, sample) => {
      const s = Inp3Sntt.seed(seed);
      const before = s.ms;
      const after = s.update(sample);
      const lo = Math.min(before, sample);
      const hi = Math.max(before, sample);
      // the IIR is a convex combination of the previous value and the sample
      expect(after.ms).toBeGreaterThanOrEqual(lo);
      expect(after.ms).toBeLessThanOrEqual(hi);
    },
  );

  // ── overflow / range bounds (§0.3) ────────────────────────────────────

  it("sample above the horizon is clamped to SNTT_SAMPLE_MAX_MS on seed", () => {
    // C# uses uint.MaxValue - 1; the JS analogue is any value past the horizon.
    expect(Inp3Sntt.seed(0xffffffff - 1).ms).toBe(SNTT_SAMPLE_MAX_MS);
    expect(Inp3Sntt.fresh().update(700_000).ms).toBe(SNTT_SAMPLE_MAX_MS);
  });

  it("sample above the horizon is clamped before smoothing", () => {
    // A wild sample is clamped to 600_000 before the IIR sees it, so it cannot
    // drive SNTT past the horizon.
    let s = Inp3Sntt.seed(0);
    s = s.update(0xffffffff);
    // (7·0 + 600000 + 4)/8 = 600004/8 = 75000 — the clamped sample, smoothed.
    expect(s.ms).toBe(75_000);
  });

  it("smoothed value never exceeds SNTT_SAMPLE_MAX_MS even under max input storm", () => {
    // Pin SNTT at the top, then keep slamming max samples at the highest gain
    // (256): the convex-combination result can sit on the top but never above it,
    // and the integer accumulator (worst case 255·600000 + 600000 + 128 ≈ 1.5e8)
    // is exact in JS `number`.
    let s = Inp3Sntt.seed(SNTT_SAMPLE_MAX_MS);
    for (let i = 0; i < 100; i++) {
      s = s.update(0xffffffff, SNTT_MAX_GAIN_SHIFT);
      expect(s.ms).toBeLessThanOrEqual(SNTT_SAMPLE_MAX_MS);
    }
    // max sample at the top stays at the top
    expect(s.ms).toBe(SNTT_SAMPLE_MAX_MS);
  });

  it.each([
    [1], // gain 1/2 (denom 2): worst acc = 1·600000 + 600000 + 1
    [3], // gain 1/8 (default): worst acc = 7·600000 + 600000 + 4
    [8], // gain 1/256: worst acc = 255·600000 + 600000 + 128 ≈ 1.5e8
  ])("all valid gains keep a max × max update within range (shift %i)", (gainShift) => {
    const s = Inp3Sntt.seed(SNTT_SAMPLE_MAX_MS).update(SNTT_SAMPLE_MAX_MS, gainShift);
    expect(s.ms).toBeGreaterThanOrEqual(0);
    expect(s.ms).toBeLessThanOrEqual(SNTT_SAMPLE_MAX_MS);
    expect(s.ms).toBe(SNTT_SAMPLE_MAX_MS);
  });

  // ── configurable gain (§0.4) ──────────────────────────────────────────

  it("default update uses the default gain shift", () => {
    expect(
      Inp3Sntt.seed(50)
        .update(500)
        .equals(Inp3Sntt.seed(50).update(500, SNTT_DEFAULT_GAIN_SHIFT)),
    ).toBe(true);
  });

  it("a smaller gain shift is twitchier, a larger one is more sluggish", () => {
    // After one step from 100 toward 1000, a higher gain (1/2, shift 1) moves
    // further than the default (1/8, shift 3), which moves further than a low
    // gain (1/256, shift 8). gain = 1/(1<<shift): smaller shift ⇒ larger gain.
    const twitchy = Inp3Sntt.seed(100).update(1000, 1).ms; // gain 1/2
    const mid = Inp3Sntt.seed(100).update(1000, 3).ms; // gain 1/8 (default)
    const sluggish = Inp3Sntt.seed(100).update(1000, 8).ms; // gain 1/256

    expect(twitchy).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(sluggish);

    // Exact integer checks of the shift form, sample - seed = 900:
    //   shift 1: (1·100 + 1000 + 1) >> 1 = 1101 >> 1 = 550
    //   shift 3: (7·100 + 1000 + 4) >> 3 = 1704 >> 3 = 213
    //   shift 8: (255·100 + 1000 + 128) >> 8 = 26628 >> 8 = 104
    expect(twitchy).toBe(550);
    expect(mid).toBe(213);
    expect(sluggish).toBe(104);
  });

  it.each([
    [0], // gain 1 = no smoothing (pointless)
    [-1],
    [9], // gain 1/512 = sluggish past usefulness
    [Number.MAX_SAFE_INTEGER], // the JS analogue of int.MaxValue
  ])("an out-of-range gain shift is rejected (shift %i)", (gainShift) => {
    expect(() => Inp3Sntt.seed(100).update(200, gainShift)).toThrow(RangeError);
  });

  it.each([[SNTT_MIN_GAIN_SHIFT], [SNTT_DEFAULT_GAIN_SHIFT], [SNTT_MAX_GAIN_SHIFT]])(
    "every in-range gain shift is accepted (shift %i)",
    (gainShift) => {
      expect(() => Inp3Sntt.seed(100).update(200, gainShift)).not.toThrow();
    },
  );

  it("gain shift only applies after seeding — the first sample still seeds directly", () => {
    // The first sample seeds regardless of gain (no smoothing on sample #1).
    expect(Inp3Sntt.fresh().update(321, SNTT_MAX_GAIN_SHIFT).ms).toBe(321);
    expect(Inp3Sntt.fresh().update(321, SNTT_MIN_GAIN_SHIFT).ms).toBe(321);
  });

  // ── value-type semantics ──────────────────────────────────────────────

  it("update is pure — it does not mutate the source", () => {
    const original = Inp3Sntt.seed(100);
    const updated = original.update(1000);
    // the value is immutable; update returns a new value
    expect(original.ms).toBe(100);
    expect(updated.ms).not.toBe(100);
  });

  it("equality is by value", () => {
    expect(Inp3Sntt.seed(200).equals(Inp3Sntt.seed(200))).toBe(true);
    expect(Inp3Sntt.seed(200).equals(Inp3Sntt.seed(201))).toBe(false);
    expect(Inp3Sntt.fresh().equals(Inp3Sntt.fresh())).toBe(true);
    expect(Inp3Sntt.fresh().equals(Inp3Sntt.seed(0))).toBe(false);
  });
});
