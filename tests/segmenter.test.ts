/**
 * AX.25 §6.6 segmenter / reassembler round-trip tests — the TS port of
 * packet.net's `SegmenterTests` (`tests/Packet.Ax25.Tests/Session/SegmenterTests.cs`),
 * including the 7-bit segment-count boundary (packet.net#273): a 128-segment
 * payload round-trips and a 129-segment one throws.
 *
 * The `segment` / `Reassembler` utilities support two formats: the
 * figure-literal one (no inner-PID octet — pass `innerPid: undefined` /
 * construct `new Reassembler()`) and Dire Wolf's de-facto one (the first
 * segment carries the original L3 PID after the F/X byte — pass an `innerPid` /
 * construct `new Reassembler(true)`). The session picks between them via
 * `Ax25SessionQuirks.segmentFirstCarriesL3Pid` (default on); these tests pin
 * both formats directly at the utility level. Mirrors packet.net#279.
 */
import { describe, expect, it } from "vitest";
import { PID_NET_ROM, PID_NO_LAYER_3 } from "../src/frame.js";
import {
  Reassembler,
  SEGMENT_COUNT_MASK,
  SEGMENT_FIRST_BIT,
  SEGMENT_MAX_SEGMENTS,
  SegmentReassemblyError,
  segment,
} from "../src/sdl/segmenter.js";

describe("Segmenter / Reassembler — figure-literal round-trip", () => {
  // 32640 = MaxSegments (128) × (N1-1=255) at N1=256 — the 7-bit boundary.
  for (const payloadSize of [0, 1, 100, 254, 255, 256, 1500, 16320, 32640]) {
    it(`round-trips a ${payloadSize}-byte payload through segmenter + reassembler`, () => {
      const payload = new Uint8Array(payloadSize);
      for (let i = 0; i < payloadSize; i++) payload[i] = (i * 31) & 0xff; // deterministic pattern

      const segments = segment(payload, 256); // innerPid undefined = figure-literal

      let completed: Uint8Array | null = null;
      const reassembler = new Reassembler();
      for (const seg of segments) completed = reassembler.push(seg);

      expect(completed).not.toBeNull();
      expect((completed as Uint8Array).length).toBe(payloadSize);
      expect(Array.from(completed as Uint8Array)).toEqual(Array.from(payload));
      expect(reassembler.lastRecoveredPid).toBeNull(); // figure-literal carries no inner PID
    });
  }

  it("the boundary uses the full 7-bit count: 32640 bytes is exactly 128 segments", () => {
    const segments = segment(new Uint8Array(32640), 256);
    expect(segments.length).toBe(SEGMENT_MAX_SEGMENTS); // 128
    // First segment: First=1, remaining=127 (the top of the 7-bit field — a
    // 6-bit count would have overflowed here, which is the packet.net#273 fix).
    expect(segments[0][0] & SEGMENT_FIRST_BIT).not.toBe(0);
    expect(segments[0][0] & SEGMENT_COUNT_MASK).toBe(127);
  });
});

describe("Segmenter / Reassembler — inner-PID (Dire Wolf) round-trip", () => {
  // 32639 = largest payload at MaxSegments with the inner-PID format:
  // ceil((32639+1)/255) = 128. (254 = exactly one segment: F/X + inner-PID +
  // 254 data = 256 = N1; 255 overflows into a 2nd segment because the inner PID
  // stole the last slot of segment 0.)
  for (const payloadSize of [0, 1, 100, 254, 255, 1500, 16320, 32639]) {
    it(`round-trips a ${payloadSize}-byte payload AND recovers the L3 PID`, () => {
      const payload = new Uint8Array(payloadSize);
      for (let i = 0; i < payloadSize; i++) payload[i] = (i * 31 + 7) & 0xff;
      const l3Pid = PID_NET_ROM; // a non-default L3 PID, to prove it survives

      const segments = segment(payload, 256, l3Pid);

      let completed: Uint8Array | null = null;
      const reassembler = new Reassembler(true);
      for (const seg of segments) completed = reassembler.push(seg);

      expect(completed).not.toBeNull();
      expect((completed as Uint8Array).length).toBe(payloadSize);
      expect(Array.from(completed as Uint8Array)).toEqual(Array.from(payload));
      expect(reassembler.lastRecoveredPid).toBe(l3Pid); // recovered off the first segment
    });
  }

  it("matches Dire Wolf's worked example byte-for-byte", () => {
    // Dire Wolf's own worked example (ax25_link.c dl_data_request comment block):
    // N1 = 4, payload "ABCDEF", PID = 0xF0 →
    //   seg0 = 0x82 0xF0 'A' 'B'   (First + 2-to-follow, inner PID, N1-2 = 2 data bytes)
    //   seg1 = 0x01 'C' 'D' 'E'    (1-to-follow, N1-1 = 3 data bytes)
    //   seg2 = 0x00 'F'            (0-to-follow, last byte)
    const payload = Uint8Array.from("ABCDEF", (c) => c.charCodeAt(0));
    const segments = segment(payload, 4, PID_NO_LAYER_3);

    expect(segments.length).toBe(3); // Dire Wolf's ceil((6+1)/(4-1)) = 3 segments
    expect(Array.from(segments[0])).toEqual([0x82, 0xf0, 0x41, 0x42]);
    expect(Array.from(segments[1])).toEqual([0x01, 0x43, 0x44, 0x45]);
    expect(Array.from(segments[2])).toEqual([0x00, 0x46]);
  });
});

describe("Segmenter — header layout", () => {
  it("first segment has First bit set; remaining-count equals segments after it", () => {
    // 1500 bytes at N1=256 → per-segment payload 255 → 6 segments.
    const segments = segment(new Uint8Array(1500), 256);
    expect(segments.length).toBe(6);

    expect(segments[0][0] & SEGMENT_FIRST_BIT).not.toBe(0);
    expect(segments[0][0] & SEGMENT_COUNT_MASK).toBe(5);

    expect(segments[5][0] & SEGMENT_FIRST_BIT).toBe(0);
    expect(segments[5][0] & SEGMENT_COUNT_MASK).toBe(0);
  });
});

describe("Segmenter — rejects", () => {
  it("figure-literal: throws if the payload would need more than 128 segments (7-bit count)", () => {
    // 128 × 255 = 32640 is the limit; one more byte needs a 129th segment.
    expect(() => segment(new Uint8Array(32641), 256)).toThrow(/128/);
  });

  it("inner-PID: throws if the payload would need more than 128 segments", () => {
    // With the inner-PID octet stealing one slot, the limit is one byte lower:
    // ceil((32639+1)/255) = 128 is OK; 32640 needs 129 segments.
    expect(() => segment(new Uint8Array(32640), 256, 0xf0)).toThrow(/128/);
  });

  it("figure-literal: throws if maxInfoFieldBytes is too small (< 2)", () => {
    expect(() => segment(new Uint8Array(10), 1)).toThrow(RangeError);
  });

  it("inner-PID: throws if maxInfoFieldBytes is below 3", () => {
    // The inner-PID first segment needs room for the F/X octet, the inner-PID
    // octet, and at least one data byte — so N1 must be at least 3.
    expect(() => segment(new Uint8Array(10), 2, 0xf0)).toThrow(RangeError);
  });
});

describe("Reassembler — rejects + restart", () => {
  it("throws on a non-First segment without a prior First", () => {
    const reassembler = new Reassembler();
    // Header: First=0, remaining=5 ("I'm segment 1 of 6") with no First seen.
    const stray = Uint8Array.from([0x05, 1, 2, 3]);
    expect(() => reassembler.push(stray)).toThrow(/non-First/);
  });

  it("throws on out-of-sequence segments", () => {
    const reassembler = new Reassembler();
    reassembler.push(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 0xaa])); // First, expects 4 next
    expect(() => reassembler.push(Uint8Array.from([3, 0xbb]))).toThrow(
      /out of sequence/,
    );
  });

  it("inner-PID: throws if a first segment lacks the inner-PID octet", () => {
    const reassembler = new Reassembler(true);
    // A First segment that is only the F/X control byte — no inner-PID octet.
    expect(() => reassembler.push(Uint8Array.from([SEGMENT_FIRST_BIT | 0]))).toThrow(
      /inner-PID octet/,
    );
  });

  it("a fresh First segment mid-stream discards the partial state", () => {
    const reassembler = new Reassembler();
    reassembler.push(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 1, 2])); // start a 6-segment series
    reassembler.push(Uint8Array.from([4, 3, 4]));
    // A new First restarts the buffer; completing the fresh single-segment
    // series yields only the fresh bytes.
    const completed = reassembler.push(
      Uint8Array.from([SEGMENT_FIRST_BIT | 0, 0xde, 0xad]),
    );
    expect(Array.from(completed as Uint8Array)).toEqual([0xde, 0xad]);
  });

  it("every contract violation throws the dedicated SegmentReassemblyError type", () => {
    // The seam (SegmentationLayer.onDataIndication) catches *exactly* this
    // subclass to drop a malformed segment while letting crash-class errors
    // surface, so pin that all four documented violations throw it (not a bare
    // Error / RangeError). Mirrors the C# reassembler's documented
    // ArgumentException / InvalidOperationException contract.
    expect(() => new Reassembler().push(new Uint8Array(0))).toThrow(SegmentReassemblyError); // empty
    expect(() => new Reassembler().push(Uint8Array.from([0x05, 1, 2]))).toThrow(SegmentReassemblyError); // non-First w/o First
    const oos = new Reassembler();
    oos.push(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 0xaa]));
    expect(() => oos.push(Uint8Array.from([3, 0xbb]))).toThrow(SegmentReassemblyError); // out of sequence
    expect(() => new Reassembler(true).push(Uint8Array.from([SEGMENT_FIRST_BIT | 0]))).toThrow(
      SegmentReassemblyError,
    ); // inner-PID First missing PID octet
  });
});
