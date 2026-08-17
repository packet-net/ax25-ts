/**
 * The send window is bounded by the sequence space itself: at most
 * `modulus - 1` I-frames may be outstanding. Section 4.2.4 sizes V(S) modulo the
 * link's modulus and Section 6.4.4.1 stops transmission at V(S) = V(A) + k, but
 * both transmit gates measure the outstanding count as
 * `(V(S) - V(A)) mod modulus`, which can never reach the modulus, so a `k` at or
 * above it means "never full". The retransmit store (`sentIFrames`) is keyed by
 * the bare N(S), so the wrapping frame overwrites a still-unacknowledged entry
 * and a REJ then retransmits the wrong payload under the right sequence number:
 * silent corruption, reachable from an operator-set window of 8..127 on a mod-8
 * port (m0lte/packet.net#696). `effectiveWindow` is the single point every gate
 * reads, so the bound lives there.
 *
 * TS port of packet.net's Ax25WindowSequenceSpaceTests.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, classify, getNs, rej } from "../src/frame.js";
import { createSessionContext, effectiveWindow } from "../src/sdl/session-context.js";
import { SdlSessionDriver } from "../src/sdl/session-driver.js";
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

const LOCAL = Callsign.parse("M0LTE");
const REMOTE = Callsign.parse("G7XYZ-7");

const text = (i: number) => `payload-${String(i).padStart(2, "0")}`;
const payload = (i: number) => new TextEncoder().encode(text(i));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("effective window vs the sequence space (m0lte/packet.net#696)", () => {
  it.each([
    // mod-8, go-back-N: k at/over the modulus is bounded to modulus-1 = 7.
    { k: 8, srej: false, ext: false, expected: 7 },
    { k: 16, srej: false, ext: false, expected: 7 },
    { k: 127, srej: false, ext: false, expected: 7 },
    // ...and a legitimate mod-8 window is untouched.
    { k: 7, srej: false, ext: false, expected: 7 },
    { k: 4, srej: false, ext: false, expected: 4 },
    // mod-128, go-back-N: bounded at 127, not at the configured 128+.
    { k: 128, srej: false, ext: true, expected: 127 },
    { k: 200, srej: false, ext: true, expected: 127 },
    { k: 32, srej: false, ext: true, expected: 32 },
    // SREJ takes the tighter half-modulus cap (ax25spec#13) first; the
    // sequence-space bound never loosens it.
    { k: 8, srej: true, ext: false, expected: 4 },
    { k: 200, srej: true, ext: true, expected: 64 },
  ])(
    "never exceeds modulus-1 (k=$k srej=$srej ext=$ext -> $expected)",
    ({ k, srej, ext, expected }) => {
      const ctx = createSessionContext(LOCAL, REMOTE);
      ctx.k = k;
      ctx.srejEnabled = srej;
      ctx.isExtended = ext;
      ctx.quirks = defaultSessionQuirks;
      expect(effectiveWindow(ctx)).toBe(expected);
    },
  );

  it("bounds the window even under the strictlyFaithful quirk set", () => {
    // ax25Spec13ClampSrejWindowToHalfModulus is a figure-interpretation quirk and
    // can be turned off; the sequence-space bound is arithmetic, so it cannot.
    const ctx = createSessionContext(LOCAL, REMOTE);
    ctx.quirks = strictlyFaithfulSessionQuirks;
    ctx.k = 8;
    ctx.srejEnabled = true;
    expect(effectiveWindow(ctx)).toBe(7);
  });

  it("mod-8 go-back-N at k=8 keeps 7 outstanding and REJ retransmits the right payloads", () => {
    // One real session in Connected, mod-8, SREJ off, k = 8 (an operator-set
    // window an unfixed config validator would accept).
    const sent: Ax25Frame[] = [];
    const ctx = createSessionContext(LOCAL, REMOTE);
    ctx.k = 8;
    ctx.srejEnabled = false;
    ctx.implicitReject = true;
    ctx.isExtended = false;
    const driver = new SdlSessionDriver(
      ctx,
      new RealTimerScheduler(),
      {
        sendFrame: (f) => sent.push(f),
        emitUpward: () => {},
        freezeT1V: true,
        t1Ms: 60_000,
      },
      "Connected",
    );

    for (let i = 0; i < 12; i++) {
      driver.postEvent({ name: "DL_DATA_request", data: payload(i), pid: 0xf0 });
    }

    // Before the fix all 12 went out with N(S) = [0..7, 0, 1, 2, 3]: the window
    // gate (V(S) - V(A)) mod 8 can never report 8, so it never said "full".
    const iFrames = sent.filter((f) => classify(f) === "I");
    expect(iFrames.length).toBe(7);
    expect(iFrames.map(getNs)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(iFrames.map((f) => decode(f.info))).toEqual([0, 1, 2, 3, 4, 5, 6].map(text));
    expect(ctx.vs).toBe(7);
    expect(ctx.va).toBe(0);

    // The peer rejects from N(R) = 2: V(A) := 2, retransmit from N(S) = 2 on.
    sent.length = 0;
    driver.postEvent({
      name: "REJ_received",
      frame: rej({
        destination: LOCAL,
        source: REMOTE,
        nr: 2,
        isCommand: false,
        pollFinal: false,
      }),
    });

    expect(driver.currentState).toBe("Connected");
    // Before the fix, N(S) 2 and 3 had been overwritten in sentIFrames by the
    // wrapped payloads 10 and 11, so recovery put the wrong bytes on the air
    // under the right sequence numbers.
    const retransmitted = sent.filter((f) => classify(f) === "I").slice(0, 5);
    expect(retransmitted.map((f) => [getNs(f), decode(f.info)])).toEqual([
      [2, text(2)],
      [3, text(3)],
      [4, text(4)],
      [5, text(5)],
      [6, text(6)],
    ]);
    // The window still holds: at most 7 unacknowledged at any point.
    expect((ctx.vs - ctx.va + 8) % 8).toBeLessThanOrEqual(7);
  });
});
