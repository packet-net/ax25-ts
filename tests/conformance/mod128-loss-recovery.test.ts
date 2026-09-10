/**
 * v2.2 arc V4a — REJ and SREJ loss recovery in the mod-128 (extended) sequence
 * space. The TS port of packet.net's `Mod128LossRecoveryConformanceTests`.
 * These mirror the mod-8 recovery coverage in `loss-recovery.test.ts` but drive
 * an extended link (`TwoStationHarness.build({ extended: true })`) so the 7-bit
 * N(S)/N(R) arithmetic is exercised end-to-end — including a window-wrap across
 * the 0–127 boundary.
 *
 * ## The finding these guard
 *
 * The recovery logic in `src/sdl/session-bindings.ts` is already mod-aware:
 * every sequence computation reads `modulus(context)` (8 or 128) and is done
 * `% m` (the `V_s_eq_V_a_plus_k` send-window check, the
 * `vr_lt_ns_lt_vr_plus_k` receive-window guard, the `ns_eq_vr` / `nr_in_window` /
 * `ns_gt_vr_plus_1` comparisons), and the frame's `getNs` / `getNr` read 7-bit
 * values on extended frames (v2.2 arc V1). So SREJ/REJ recovery works at
 * modulo-128 with NO recovery-path code change — these tests prove it and stand
 * as the regression guard, exactly as on the C# side.
 *
 * The two remaining SREJ figc4.x quirks (`ax25Spec41` Karn SRT sampling,
 * `ax25Spec42` SREJ-targets-gap) are on by default in
 * `TwoStationHarness.build`, so the burst / window-wrap selective-recovery
 * cases below exercise them at mod-128 too. The out-of-window discard that was
 * the third of them is drawn in figc4.4/figc4.5 themselves since ax25spec#40,
 * so it applies under the strictly-faithful preset as well.
 */
import { describe, expect, it } from "vitest";
import { classify, getNs, type Ax25Frame } from "../../src/frame.js";
import { iFrameFrom, TwoStationHarness } from "./two-station-harness.js";

/** A one-shot drop latch: drops the first frame matching `match`, then never
 * again. Mirrors the `dropped` flag in the C# single-drop tests. */
function dropOnce(match: (f: Ax25Frame) => boolean): (f: Ax25Frame) => boolean {
  let done = false;
  return (f) => {
    if (done) return false;
    if (!match(f)) return false;
    done = true;
    return true;
  };
}

describe("mod-128 loss recovery (V4a)", () => {
  it("REJ recovers a single dropped I-frame in the 7-bit space", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });
    h.connect();
    expect(h.a.context.isExtended).toBe(true); // the harness negotiates mod-128 via SABME
    expect(h.b.context.isExtended).toBe(true);
    h.checkAfterEachStep = false;

    // Drop A's N(S)=2 I-frame once. SREJ disabled (default) → B's figc4.4 REJ
    // go-back-N path. `iFrameFrom` matches the mode-aware 7-bit N(S).
    h.dropWhen(dropOnce(iFrameFrom(h.a, 2)));
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);

    expect(h.b.delivered.map((d) => d[0])).toEqual([0, 1, 2, 3, 4, 5]);
    h.assertConverged();
  });

  it("SREJ recovers a single dropped I-frame in the 7-bit space", () => {
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8 });
    h.connect();
    h.checkAfterEachStep = false;

    h.dropWhen(dropOnce(iFrameFrom(h.a, 3)));
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);

    expect(h.b.delivered.map((d) => d[0])).toEqual([0, 1, 2, 3, 4, 5]);
    h.assertConverged();
  });

  // A multi-frame SREJ burst at mod-128 — the same shape as the mod-8 heavy
  // burst regression (needs all three figc4.x SREJ quirks), in the extended
  // sequence space.
  it("SREJ recovers a multi-frame loss burst in the 7-bit space", () => {
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 8,
      n2: 40,
    });
    h.connect();
    h.checkAfterEachStep = false;

    // Deterministic LCG drop pattern, finite budget (mirrors the C# Random(2)
    // burst), so the channel always clears.
    let state = 2 >>> 0;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    let dropsLeft = 4;
    h.dropWhen(() => {
      if (dropsLeft > 0 && next() < 0.5) {
        dropsLeft--;
        return true;
      }
      return false;
    });

    for (let i = 0; i < 8; i++) h.submit(h.a, i);
    h.recoverUntilConverged(80);
    h.assertConverged();
  });

  // The headline mod-128 property: a window that WRAPS the 0→127 boundary.
  // Pre-advance both sequence variables close to the top of the 7-bit space
  // (V(S)=V(A)=V(R)=124 on both ends — a valid "freshly connected at offset
  // 124" state), then transfer a burst that wraps past 127→0 with a single
  // drop. If any computation were not mod-128-aware (a stray % 8, or a window
  // check that didn't wrap) recovery would diverge here.
  for (const srej of [false, true]) {
    const mode = srej ? "SREJ" : "REJ";
    it(`recovery converges across the 127→0 window wrap [${mode}]`, () => {
      const h = TwoStationHarness.build({
        extended: true,
        srej,
        k: 8,
        n2: 40,
      });
      h.connect();
      h.checkAfterEachStep = false;

      // Seed both ends near the wrap. Both sides agree, so the link is
      // consistent — V(S)=V(A) (nothing outstanding), V(R) matches the peer's
      // V(S). Indistinguishable from having already sent 124 frames.
      const seed = 124;
      h.a.context.vs = h.a.context.va = seed;
      h.a.context.vr = seed;
      h.b.context.vs = h.b.context.va = seed;
      h.b.context.vr = seed;

      // Drop the frame whose N(S) sits just past the wrap (N(S)=0) so recovery
      // has to re-request a sequence number on the other side of 0.
      h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));

      // Eight frames from seed: N(S) = 124,125,126,127,0,1,2,3 — wraps the ring.
      for (let i = 0; i < 8; i++) h.submit(h.a, 0x40 + i);
      h.recoverUntilConverged(60);

      expect(h.b.delivered.map((d) => d[0])).toEqual(
        Array.from({ length: 8 }, (_, i) => 0x40 + i),
      );
      expect(h.a.context.vs).toBe(4); // V(S) must wrap: 124 + 8 = 132 mod 128 = 4
      h.assertConverged();
    });
  }
});

// A sanity check that the wrap test's drop predicate actually fires (the C#
// test asserts `dropped` indirectly via convergence; here we pin that an
// N(S)=0 I-frame really appears on the wire after seeding to 124, so the test
// is not vacuously green).
describe("mod-128 window-wrap — the drop target really occurs", () => {
  it("an N(S)=0 I-frame crosses the wire after seeding V(S)=124 and sending 5+", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });
    h.connect();
    h.checkAfterEachStep = false;
    const seed = 124;
    h.a.context.vs = h.a.context.va = seed;
    h.a.context.vr = seed;
    h.b.context.vs = h.b.context.va = seed;
    h.b.context.vr = seed;
    for (let i = 0; i < 6; i++) h.submit(h.a, 0x40 + i);
    const nsZero = h.link.log.filter((f) => classify(f) === "I" && getNs(f) === 0);
    expect(nsZero.length).toBeGreaterThan(0);
    h.assertConverged();
  });
});
