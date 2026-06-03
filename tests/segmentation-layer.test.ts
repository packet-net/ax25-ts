/**
 * Unit tests for {@link SegmentationLayer} — the AX.25 v2.2 §2.4 / §6.6
 * segmentation-reassembly boundary process. The TS port of packet.net's
 * `SegmentationLayerTests`. Cover the send-side decision (segment /
 * pass-through / reject), the receive-side reassembly, the PID handling, and
 * the gating on the negotiated segmenter flag.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { PID_NET_ROM, PID_NO_LAYER_3, PID_SEGMENTED } from "../src/frame.js";
import {
  type DataLinkDataIndication,
  SegmentationLayer,
} from "../src/sdl/segmentation-layer.js";
import { SEGMENT_FIRST_BIT } from "../src/sdl/segmenter.js";
import { createSessionContext } from "../src/sdl/session-context.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";

function ctx(
  n1: number,
  segmenterEnabled: boolean,
  quirks: Ax25SessionQuirks = defaultSessionQuirks,
) {
  const c = createSessionContext(
    Callsign.parse("M0LTEA-1"),
    Callsign.parse("M0LTEB-2"),
  );
  c.n1 = n1;
  c.segmenterReassemblerEnabled = segmenterEnabled;
  c.quirks = { ...quirks };
  return c;
}

/** Build a DL-DATA-indication signal (the shim's receive input). */
function indication(data: Uint8Array, pid: number): DataLinkDataIndication {
  return { type: "DL_DATA_indication", data, pid };
}

describe("SegmentationLayer — send", () => {
  it("passes a payload within N1 through unchanged", () => {
    const seg = new SegmentationLayer(ctx(256, true));
    const payload = new Uint8Array(100);

    const requests = seg.buildSendRequests(payload, PID_NO_LAYER_3);

    expect(requests.length).toBe(1);
    expect(requests[0].pid).toBe(PID_NO_LAYER_3); // pass-through preserves the L3 PID
    expect(requests[0].data).toBe(payload);
  });

  it("passes an exactly-N1 payload through unchanged", () => {
    const seg = new SegmentationLayer(ctx(256, true));
    const payload = new Uint8Array(256); // exactly N1 — fits one info field, no segment byte

    const requests = seg.buildSendRequests(payload);

    expect(requests.length).toBe(1);
    expect(requests[0].pid).toBe(PID_NO_LAYER_3);
  });

  it("segments an over-N1 payload into PID-0x08 requests", () => {
    const seg = new SegmentationLayer(ctx(64, true));
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);

    const requests = seg.buildSendRequests(payload);

    // 300 bytes, 63 payload bytes/segment (N1−1) ⇒ ceil(300/63) = 5 segments.
    expect(requests.length).toBe(5);
    expect(requests.every((r) => r.pid === PID_SEGMENTED)).toBe(true);
    expect(requests.every((r) => (r.data as Uint8Array).length <= 64)).toBe(true);
  });

  it("rejects an over-N1 payload when the segmenter is not negotiated", () => {
    const seg = new SegmentationLayer(ctx(256, false));
    const payload = new Uint8Array(300); // > N1, segmenter off

    expect(() => seg.buildSendRequests(payload)).toThrow(
      /segmenter\/reassembler has not been negotiated/,
    );
  });

  it("passes a within-N1 payload even when the segmenter is off", () => {
    const seg = new SegmentationLayer(ctx(256, false));
    const requests = seg.buildSendRequests(new Uint8Array(200));
    expect(requests.length).toBe(1);
  });
});

describe("SegmentationLayer — receive", () => {
  it("passes a non-segment indication through unchanged", () => {
    const seg = new SegmentationLayer(ctx(256, true));
    const ind = indication(Uint8Array.from([1, 2, 3]), PID_NO_LAYER_3);

    const delivered = seg.onDataIndication(ind);

    expect(delivered).toBe(ind); // a non-0x08 indication is returned unchanged
  });

  it("reassembles a segmented series and delivers on the last segment", () => {
    const n1 = 64;
    const send = new SegmentationLayer(ctx(n1, true));
    const recv = new SegmentationLayer(ctx(n1, true));
    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);

    const segments = send.buildSendRequests(payload);

    let final: DataLinkDataIndication | null = null;
    let deliveredBeforeLast = 0;
    for (let i = 0; i < segments.length; i++) {
      const ind = indication(segments[i].data as Uint8Array, segments[i].pid as number);
      const result = recv.onDataIndication(ind);
      if (i < segments.length - 1) {
        expect(result).toBeNull();
        if (result !== null) deliveredBeforeLast++;
      } else {
        final = result;
      }
    }

    expect(deliveredBeforeLast).toBe(0);
    expect(final).not.toBeNull();
    expect(Array.from((final as DataLinkDataIndication).data)).toEqual(
      Array.from(payload),
    );
  });

  it("default quirk preserves the original L3 PID through a segmented series", () => {
    // Default (segmentFirstCarriesL3Pid on): the first segment carries the
    // original L3 PID after the F/X byte (Dire Wolf's format), so the
    // reassembler recovers it and delivers the reassembled payload with that
    // ORIGINAL PID — not PID_NO_LAYER_3. This both interoperates with Dire Wolf
    // and fixes the figure-literal PID-loss limitation. Pin that contract.
    const n1 = 16;
    const send = new SegmentationLayer(ctx(n1, true)); // default quirks
    const recv = new SegmentationLayer(ctx(n1, true));
    const payload = new Uint8Array(40);

    const segments = send.buildSendRequests(payload, PID_NET_ROM);
    let final: DataLinkDataIndication | null = null;
    for (const s of segments) {
      const r = recv.onDataIndication(
        indication(s.data as Uint8Array, s.pid as number),
      );
      if (r !== null) final = r;
    }

    expect(final).not.toBeNull();
    expect((final as DataLinkDataIndication).pid).toBe(PID_NET_ROM); // recovered original L3 PID
    expect(Array.from((final as DataLinkDataIndication).data)).toEqual(
      Array.from(payload),
    );
  });

  it("strictlyFaithful uses the figure-literal format and delivers PID_NO_LAYER_3", () => {
    // strictlyFaithful (segmentFirstCarriesL3Pid off): Figure 6.2 literally —
    // no inner-PID octet, so the original L3 PID cannot be recovered and the
    // reassembled payload is delivered as PID_NO_LAYER_3. The first segment's
    // info field is [F/X][data] (no inner-PID octet between them). Pin the
    // strict figure-literal contract alongside the default.
    const n1 = 16;
    const quirks = strictlyFaithfulSessionQuirks;
    const send = new SegmentationLayer(ctx(n1, true, quirks));
    const recv = new SegmentationLayer(ctx(n1, true, quirks));
    const payload = new Uint8Array(40); // payload[0] === 0, distinct from PID_NET_ROM (0xCF)

    const segments = send.buildSendRequests(payload, PID_NET_ROM);

    // The first segment's second byte is the start of PAYLOAD (figure-literal),
    // NOT the inner PID. (payload[0] === 0, distinct from PID_NET_ROM 0xCF.)
    expect((segments[0].data as Uint8Array)[0] & SEGMENT_FIRST_BIT).not.toBe(0);
    expect((segments[0].data as Uint8Array)[1]).toBe(0); // first payload byte, not an inner PID

    let final: DataLinkDataIndication | null = null;
    for (const s of segments) {
      const r = recv.onDataIndication(
        indication(s.data as Uint8Array, s.pid as number),
      );
      if (r !== null) final = r;
    }

    expect(SegmentationLayer.figureLiteralReassembledPid).toBe(PID_NO_LAYER_3);
    expect(final).not.toBeNull();
    expect((final as DataLinkDataIndication).pid).toBe(PID_NO_LAYER_3);
    expect(Array.from((final as DataLinkDataIndication).data)).toEqual(
      Array.from(payload),
    );
  });
});

describe("SegmentationLayer — receive: malformed segments are dropped cleanly at the wire seam", () => {
  // The TS port of packet.net's SegmentReassemblerThrowOnWireFindingTests
  // (packet.net#284). A hostile / malformed PID-0x08 segment off the wire reaches
  // SegmentationLayer.onDataIndication (mirrors C#'s OnDataIndication). The seam
  // now catches Reassembler.push's documented SegmentReassemblyError, drops the
  // bad segment cleanly (returns null — the same "nothing to deliver yet" signal
  // as a legitimate mid-series segment), and resets any in-progress reassembly,
  // WITHOUT relying on the listener's catch-all. The four finding inputs are the
  // analogues of C#'s `05 AA BB`, empty, `80`, and the `85 CC` → `03 DD`
  // out-of-sequence pair. The low-level Reassembler.push contract is unchanged —
  // its direct-call tests in segmenter.test.ts still pin the strict throw.

  it("case 1 — a non-First segment with no prior First is dropped cleanly", () => {
    // Hex input (segment info field): 05 AA BB (First bit clear, remaining = 5).
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks));
    expect(() => layer.onDataIndication(indication(Uint8Array.from([0x05, 0xaa, 0xbb]), PID_SEGMENTED))).not.toThrow();
    // A second identical malformed segment still delivers nothing upward.
    expect(layer.onDataIndication(indication(Uint8Array.from([0x05, 0xaa, 0xbb]), PID_SEGMENTED))).toBeNull();
  });

  it("case 2 — an empty 0x08-PID info field is dropped cleanly", () => {
    // Hex input (segment info field): (empty).
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks));
    expect(() => layer.onDataIndication(indication(new Uint8Array(0), PID_SEGMENTED))).not.toThrow();
    expect(layer.onDataIndication(indication(new Uint8Array(0), PID_SEGMENTED))).toBeNull();
  });

  it("case 3 — under the inner-PID quirk, a First carrying only the F/X octet (no inner PID) is dropped cleanly", () => {
    // Hex input: 80 (First bit set, remaining = 0, no inner-PID octet). Uses the
    // DEFAULT quirk (segmentFirstCarriesL3Pid on) so the reassembler expects the
    // inner-PID octet — matching C#'s NewWireLayer(Ax25SessionQuirks.Default).
    const layer = new SegmentationLayer(ctx(256, true, defaultSessionQuirks));
    expect(() => layer.onDataIndication(indication(Uint8Array.from([0x80]), PID_SEGMENTED))).not.toThrow();
    expect(layer.onDataIndication(indication(Uint8Array.from([0x80]), PID_SEGMENTED))).toBeNull();
  });

  it("case 4 — an out-of-sequence continuation is dropped cleanly", () => {
    // strictlyFaithful so the first segment isn't consumed as inner-PID.
    // First 85 CC (First bit + remaining 5), then 03 DD (remaining 3 where 4 expected).
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks));
    expect(layer.onDataIndication(indication(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 0xcc]), PID_SEGMENTED))).toBeNull();
    expect(() => layer.onDataIndication(indication(Uint8Array.from([3, 0xdd]), PID_SEGMENTED))).not.toThrow();
  });

  it("reset half — a valid series after a dropped out-of-sequence continuation still reassembles intact", () => {
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks)); // figure-literal: no inner PID

    // Start a series, then break it with an out-of-sequence continuation (dropped + resets).
    expect(layer.onDataIndication(indication(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 0xcc]), PID_SEGMENTED))).toBeNull();
    expect(layer.onDataIndication(indication(Uint8Array.from([3, 0xdd]), PID_SEGMENTED))).toBeNull();

    // A fresh, well-formed two-segment series. If the reset worked, the stale
    // partial state is gone and this reassembles cleanly with no leakage.
    expect(layer.onDataIndication(indication(Uint8Array.from([SEGMENT_FIRST_BIT | 1, 0xaa]), PID_SEGMENTED))).toBeNull();
    const delivered = layer.onDataIndication(indication(Uint8Array.from([0, 0xbb]), PID_SEGMENTED));

    expect(delivered).not.toBeNull();
    expect(Array.from((delivered as DataLinkDataIndication).data)).toEqual([0xaa, 0xbb]);
    expect((delivered as DataLinkDataIndication).pid).toBe(SegmentationLayer.figureLiteralReassembledPid);
  });

  it("reset half — a valid series after a dropped stray non-First still reassembles", () => {
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks));

    // Stray non-First with no prior First — dropped.
    expect(layer.onDataIndication(indication(Uint8Array.from([0x05, 0xaa, 0xbb]), PID_SEGMENTED))).toBeNull();

    // A well-formed single-segment series then arrives and is delivered.
    const delivered = layer.onDataIndication(indication(Uint8Array.from([SEGMENT_FIRST_BIT | 0, 0x42]), PID_SEGMENTED));
    expect(delivered).not.toBeNull();
    expect(Array.from((delivered as DataLinkDataIndication).data)).toEqual([0x42]);
  });

  it("happy-path counterpart — a clean two-segment series with no preceding malformed input reassembles", () => {
    const layer = new SegmentationLayer(ctx(256, true, strictlyFaithfulSessionQuirks));
    expect(layer.onDataIndication(indication(Uint8Array.from([SEGMENT_FIRST_BIT | 1, 0x01]), PID_SEGMENTED))).toBeNull();
    const delivered = layer.onDataIndication(indication(Uint8Array.from([0, 0x02]), PID_SEGMENTED));
    expect(delivered).not.toBeNull();
    expect(Array.from((delivered as DataLinkDataIndication).data)).toEqual([0x01, 0x02]);
  });
});
