/**
 * The `ax25Spec13ClampSrejWindowToHalfModulus` quirk (packethacking/ax25spec#13).
 * Selective Repeat (SREJ) requires the send window k <= modulus/2 (the
 * 2*W <= modulus bound) because recovery state is keyed by the bare N(S). Above
 * the cap, two in-flight frames can share an N(S) and SREJ recovery silently
 * delivers a stale stored I-frame from the previous ring cycle
 * (m0lte/packet.net#393, found by tools/Packet.LinkBench: corruption at mod-8
 * k>=5, clean at k<=4). With the quirk on (default) effectiveWindow caps the
 * window at modulus/2 while SREJ is in effect; off, the figure-literal uncapped
 * k applies.
 *
 * TS port of packet.net's Ax25Spec13SrejWindowClampTests.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25SessionContext,
  createSessionContext,
  effectiveWindow,
} from "../src/sdl/session-context.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";

function ctx(
  k: number,
  srej: boolean,
  extended: boolean,
  quirks: Ax25SessionQuirks,
): Ax25SessionContext {
  const c = createSessionContext(Callsign.parse("M0LTE"), Callsign.parse("G7XYZ-7"));
  c.quirks = quirks;
  c.isExtended = extended;
  c.k = k;
  c.srejEnabled = srej;
  return c;
}

describe("ax25Spec13ClampSrejWindowToHalfModulus (packethacking/ax25spec#13)", () => {
  it.each([
    // mod-8 (modulus/2 = 4): SREJ caps above 4, leaves <=4 alone.
    { k: 7, srej: true, ext: false, expected: 4 },
    { k: 5, srej: true, ext: false, expected: 4 },
    { k: 4, srej: true, ext: false, expected: 4 },
    { k: 3, srej: true, ext: false, expected: 3 },
    // mod-128 (modulus/2 = 64).
    { k: 100, srej: true, ext: true, expected: 64 },
    { k: 32, srej: true, ext: true, expected: 32 },
    // SREJ off (go-back-N) is never capped.
    { k: 7, srej: false, ext: false, expected: 7 },
    { k: 100, srej: false, ext: true, expected: 100 },
  ])(
    "effective window is capped at half-modulus only under SREJ (k=$k srej=$srej ext=$ext -> $expected)",
    ({ k, srej, ext, expected }) => {
      expect(effectiveWindow(ctx(k, srej, ext, defaultSessionQuirks))).toBe(expected);
    },
  );

  it("strictlyFaithful leaves the window uncapped (reproduces the unsafe figure behaviour)", () => {
    expect(
      effectiveWindow(ctx(7, true, false, strictlyFaithfulSessionQuirks)),
    ).toBe(7);
  });

  it("the default mod-8 window is unchanged by the clamp", () => {
    // k=4 = modulus/2: at the safe limit, untouched whether SREJ is on or off.
    expect(effectiveWindow(ctx(4, true, false, defaultSessionQuirks))).toBe(4);
    expect(effectiveWindow(ctx(4, false, false, defaultSessionQuirks))).toBe(4);
  });
});
