/**
 * v2.2 arc V4b (and the V4 headline exit criterion) — the *wired*
 * segmentation/reassembly path end-to-end over the two-station harness, the TS
 * port of packet.net's `SegmentationIntegrationConformanceTests`. The §6.6 shim
 * ({@link SegmentationLayer}) is wired into each session's DL boundary:
 * `submitLarge` segments on send and the receive-side reassembler surfaces one
 * reassembled DL-DATA indication, so the convergence oracle compares one
 * logical submission to one logical delivery.
 */
import { describe, expect, it } from "vitest";
import { classify, type Ax25Frame, PID_NET_ROM, PID_NO_LAYER_3 } from "../../src/frame.js";
import { strictlyFaithfulSessionQuirks } from "../../src/sdl/session-quirks.js";
import { iFrameFrom, TwoStationHarness } from "./two-station-harness.js";

/** One-shot drop latch (mirrors the C# `dropped` flag). */
function dropOnce(match: (f: Ax25Frame) => boolean): (f: Ax25Frame) => boolean {
  let done = false;
  return (f) => {
    if (done) return false;
    if (!match(f)) return false;
    done = true;
    return true;
  };
}

describe("wired segmentation integration (V4b)", () => {
  it("round-trips a large payload over a mod-8 link", () => {
    const h = TwoStationHarness.build({ k: 8, segmenter: true, n1: 64 });
    h.connect();
    expect(h.a.context.segmenterReassemblerEnabled).toBe(true);

    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    h.submitLarge(h.a, payload);
    h.settle();

    // The five segments reassemble into ONE upper-layer payload.
    expect(h.b.delivered.length).toBe(1);
    expect(Array.from(h.b.delivered[0])).toEqual(Array.from(payload));
    h.assertConverged();
  });

  // The V4 headline exit criterion (plan §5.Z V4): a > N1 payload segments on
  // send, reassembles on receive over a MOD-128 link, AND SREJ recovers a lost
  // segment. Combines V4a (SREJ in the 7-bit space) + V4b (segmentation shim).
  it("over-N1 payload segments, reassembles, and SREJ recovers a lost segment (mod-128)", () => {
    // Extended (mod-128), SREJ enabled, segmenter negotiated, small N1 so a
    // modest payload spans several segments. k=16 so the whole series fits the
    // send window (the drop is recovered selectively, not by a window stall).
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 16,
      n2: 40,
      segmenter: true,
      n1: 64,
    });
    h.connect();
    expect(h.a.context.isExtended).toBe(true); // the link must be mod-128
    expect(h.a.context.segmenterReassemblerEnabled).toBe(true); // segmenter negotiated
    h.checkAfterEachStep = false;

    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 3 + 1) & 0xff); // 5 segments at N1=64

    // Drop exactly ONE segment in flight (the third I-frame A sends, N(S)=2),
    // then the channel is clean. SREJ must re-request and recover it.
    const dropper = dropOnce(iFrameFrom(h.a, 2));
    let dropped = false;
    h.dropWhen((f) => {
      const d = dropper(f);
      if (d) dropped = true;
      return d;
    });

    h.submitLarge(h.a, payload);
    for (let r = 0; r < 40 && h.b.delivered.length === 0; r++) h.advanceT1();

    expect(dropped).toBe(true); // the scenario must actually have dropped a segment
    // The lost segment must be recovered SELECTIVELY — B must have put an SREJ
    // on the wire (not merely a T1-timeout go-back-N).
    expect(h.a.receivedFromPeer.some((f) => classify(f) === "SREJ")).toBe(true);
    // After SREJ recovers the lost segment, the receiver reassembles exactly
    // ONE payload, byte-for-byte the original.
    expect(h.b.delivered.length).toBe(1);
    expect(Array.from(h.b.delivered[0])).toEqual(Array.from(payload));
    h.assertConverged();
  });

  // Same, but REJ go-back-N recovery (SREJ off) — the lost segment is recovered
  // by retransmitting from the gap; reassembly must still be intact.
  it("over-N1 payload segments, reassembles, and REJ recovers a lost segment (mod-128)", () => {
    const h = TwoStationHarness.build({
      extended: true,
      srej: false,
      k: 16,
      n2: 40,
      segmenter: true,
      n1: 64,
    });
    h.connect();
    h.checkAfterEachStep = false;

    const payload = Uint8Array.from({ length: 250 }, (_, i) => (255 - i) & 0xff);

    const dropper = dropOnce(iFrameFrom(h.a, 1));
    let dropped = false;
    h.dropWhen((f) => {
      const d = dropper(f);
      if (d) dropped = true;
      return d;
    });

    h.submitLarge(h.a, payload);
    for (let r = 0; r < 40 && h.b.delivered.length === 0; r++) h.advanceT1();

    expect(dropped).toBe(true);
    expect(h.b.delivered.length).toBe(1);
    expect(Array.from(h.b.delivered[0])).toEqual(Array.from(payload));
    h.assertConverged();
  });

  it("over-N1 payload on a session without the negotiated segmenter is rejected", () => {
    // v2.0 / not-negotiated: an over-N1 payload must be rejected cleanly at the
    // shim, never truncated or sent oversize.
    const h = TwoStationHarness.build({ k: 8, segmenter: false });
    h.connect();

    const payload = new Uint8Array(h.a.context.n1 + 50);
    expect(() => h.submitLarge(h.a, payload)).toThrow(
      /segmenter\/reassembler has not been negotiated/,
    );
  });

  // Default format (segmentFirstCarriesL3Pid on) — the wired round-trip must
  // PRESERVE the original L3 PID through the segmented series (Dire Wolf's
  // first-segment inner-PID format), not flatten it to PID_NO_LAYER_3.
  it("default wired segmentation preserves the original L3 PID", () => {
    const h = TwoStationHarness.build({ k: 8, segmenter: true, n1: 64 }); // default quirks
    h.connect();

    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    h.submitLarge(h.a, payload, PID_NET_ROM); // a non-default L3 PID
    h.flushAcks();

    // The segments reassemble into ONE upper-layer payload …
    expect(h.b.delivered.length).toBe(1);
    expect(Array.from(h.b.delivered[0])).toEqual(Array.from(payload));
    // … and the default inner-PID format carries + recovers the original L3 PID.
    expect(h.b.deliveredPids.length).toBe(1);
    expect(h.b.deliveredPids[0]).toBe(PID_NET_ROM);
    h.assertConverged();
  });

  // strictlyFaithful (segmentFirstCarriesL3Pid off) — the wired round-trip uses
  // the figure-literal format: payload still reassembles intact, but the L3 PID
  // is NOT recovered and the reassembled payload is delivered as PID_NO_LAYER_3.
  // Pins Figure 6.2 exactly as drawn alongside the default.
  it("strictlyFaithful wired segmentation is figure-literal and delivers PID_NO_LAYER_3", () => {
    const h = TwoStationHarness.build({
      k: 8,
      segmenter: true,
      n1: 64,
      quirks: strictlyFaithfulSessionQuirks,
    });
    h.connect();

    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 5 + 2) & 0xff);
    h.submitLarge(h.a, payload, PID_NET_ROM); // send a non-default L3 PID …
    h.flushAcks();

    // The figure-literal segments still reassemble into ONE payload …
    expect(h.b.delivered.length).toBe(1);
    expect(Array.from(h.b.delivered[0])).toEqual(Array.from(payload));
    // … but the figure-literal format carries no inner PID, so it is lost and
    // the payload is delivered as PID_NO_LAYER_3.
    expect(h.b.deliveredPids.length).toBe(1);
    expect(h.b.deliveredPids[0]).toBe(PID_NO_LAYER_3);
    h.assertConverged();
  });
});
