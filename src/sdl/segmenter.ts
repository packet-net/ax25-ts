/**
 * AX.25 v2.2 §6.6 segmentation / reassembly — the TS analogue of packet.net's
 * `Segmenter` / `Reassembler` (`src/Packet.Ax25/Session/Segmenter.cs`, as fixed
 * in packet.net#273 to a 7-bit count). Splits a long upper-layer payload into a
 * sequence of I-frame info-field byte arrays (each prefixed with the segment
 * control octet) on the send side, and accumulates them back into one payload
 * on the receive side.
 *
 * Segment control byte format (AX.25 v2.2 Figure 6.2 — `FXXXXXXX`, value
 * `F*128+X`):
 *
 * ```
 * bit 7    = First indicator (1 on the first segment of a series)
 * bits 6:0 = X, the 7-bit count of segments still to come
 * ```
 *
 * With 7 bits of remaining-count, a payload may span at most 128 segments. At
 * the default N1=256 the per-segment payload is 255 bytes, so the maximum
 * upper-layer payload through the segmenter is 128 × 255 = 32 640 bytes.
 * (Figure 6.2 makes X a 7-bit field; direwolf masks the count with `0x7f` —
 * `ax25_link.c` reassembler — so both spec and de-facto agree the count is
 * 7-bit, not 6. This mirrors the packet.net#273 fix.)
 *
 * Layer-3 packets segmented this way travel as I-frames with PID
 * {@link PID_SEGMENTED} (0x08); reassembly is the receiving side's job (see
 * {@link Reassembler}).
 *
 * ## First-segment inner PID (de-facto-interop format)
 *
 * Figure 6.2's two-octet header carries no field for the original Layer-3 PID,
 * so the figure-literal format loses it across a segmented series. Dire Wolf —
 * the only known v2.2 segmenter — prepends the original PID as an extra octet
 * at the front of the **first** segment, between the F/X octet and the data, so
 * its reassembler can recover it. Pass `innerPid` to {@link segment} to emit
 * that format (the inner octet counts toward the segment budget — the first
 * segment then holds N1−2 data bytes, subsequent segments N1−1). Pass
 * `undefined` for the figure-literal format. The session selects between them
 * via {@link Ax25SessionQuirks.segmentFirstCarriesL3Pid}. Mirrors the C#
 * `Segmenter` / `Reassembler` (packet.net#279).
 */
import { PID_SEGMENTED } from "../frame.js";

/** First-segment indicator (bit 7 of the segment control byte). */
export const SEGMENT_FIRST_BIT = 0x80;

/** Seven-bit mask for the remaining-count field (bits 6:0), per Figure 6.2. */
export const SEGMENT_COUNT_MASK = 0x7f;

/** Maximum number of segments a single upper-layer payload may span (7-bit count → 128). */
export const SEGMENT_MAX_SEGMENTS = 128;

/**
 * The error {@link Reassembler.push} throws when a *segment* it is handed
 * violates the reassembly contract — an empty info field, an inner-PID first
 * segment with no PID octet, a non-First segment with no prior First, or an
 * out-of-sequence continuation. It is a dedicated subclass (rather than a bare
 * `Error` / `RangeError`) so a wire-facing caller can catch *exactly* these
 * protocol violations and let any other (crash-class) error surface
 * unmasked — the TS analogue of the C# reassembler's documented
 * `ArgumentException` / `InvalidOperationException` contract, which
 * {@link SegmentationLayer} catches narrowly at the receive seam
 * (packet.net#284).
 *
 * `push`'s throw contract is unchanged in substance: it still throws on every
 * one of these cases, with the same human-readable messages — only the concrete
 * error type is narrowed from the JS built-ins to this subclass.
 */
export class SegmentReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentReassemblyError";
  }
}

// Re-export so callers segmenting can reach the PID from one place.
export { PID_SEGMENTED };

/**
 * Split a payload into I-frame info fields. Each info field is prefixed with
 * the segment control byte; the rest is up to `maxInfoFieldBytes − 1` bytes of
 * payload (figure-literal format), or — when `innerPid` is supplied — the first
 * segment additionally carries that inner-PID octet after the F/X byte (Dire
 * Wolf's de-facto format), so its data capacity is `maxInfoFieldBytes − 2`. An
 * empty payload yields a single (first + last) segment carrying no data bytes
 * (figure-literal) or only the inner-PID octet (inner-PID format). Mirrors the
 * C# `Segmenter.Segment`.
 *
 * @param payload The upper-layer payload to segment.
 * @param maxInfoFieldBytes N1 — the max info-field size per I-frame.
 * @param innerPid When supplied, emit Dire Wolf's format: the original Layer-3
 *   PID is written as an extra octet on the *first* segment (between the F/X
 *   octet and the data) and counts toward the segment budget. When `undefined`,
 *   emit the figure-literal format (no inner-PID octet).
 * @throws RangeError if `maxInfoFieldBytes` is < 2 (figure-literal) or < 3
 *   (inner-PID format — the first segment needs room for the F/X octet, the
 *   inner-PID octet, and at least one data byte).
 * @throws RangeError if `payload` would need more than {@link SEGMENT_MAX_SEGMENTS}
 *   segments.
 */
export function segment(
  payload: Uint8Array,
  maxInfoFieldBytes: number,
  innerPid?: number,
): Uint8Array[] {
  return innerPid === undefined
    ? segmentFigureLiteral(payload, maxInfoFieldBytes)
    : segmentWithInnerPid(payload, maxInfoFieldBytes, innerPid);
}

/**
 * Figure-literal format: every segment info field is
 * `[F/X octet][≤ N1−1 payload bytes]`.
 */
function segmentFigureLiteral(
  payload: Uint8Array,
  maxInfoFieldBytes: number,
): Uint8Array[] {
  if (maxInfoFieldBytes < 2) {
    throw new RangeError(
      "maxInfoFieldBytes must be at least 2 (1 byte for the segment control byte + at least 1 byte of payload)",
    );
  }

  const perSegment = maxInfoFieldBytes - 1;
  const segmentCount =
    payload.length === 0
      ? 1
      : Math.ceil(payload.length / perSegment);
  if (segmentCount > SEGMENT_MAX_SEGMENTS) {
    throw new RangeError(
      `payload of ${payload.length} bytes would need ${segmentCount} segments at N1=${maxInfoFieldBytes}; max is ${SEGMENT_MAX_SEGMENTS}`,
    );
  }

  const result: Uint8Array[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const remaining = segmentCount - 1 - i;
    const firstBit = i === 0 ? SEGMENT_FIRST_BIT : 0;
    const header = firstBit | (remaining & SEGMENT_COUNT_MASK);

    const offset = i * perSegment;
    const thisLen = Math.min(perSegment, payload.length - offset);
    const out = new Uint8Array(1 + Math.max(thisLen, 0));
    out[0] = header;
    if (thisLen > 0) out.set(payload.subarray(offset, offset + thisLen), 1);
    result.push(out);
  }
  return result;
}

/**
 * Dire Wolf's de-facto format: the first segment info field is
 * `[F/X octet][inner-PID octet][≤ N1−2 payload bytes]`; subsequent segments are
 * `[F/X octet][≤ N1−1 payload bytes]`. The inner-PID octet counts toward the
 * budget — Dire Wolf computes the segment count as `ceil((len + 1) / (N1 − 1))`
 * ("+1 for the original PID"; `ax25_link.c` `dl_data_request`).
 */
function segmentWithInnerPid(
  payload: Uint8Array,
  maxInfoFieldBytes: number,
  innerPid: number,
): Uint8Array[] {
  if (maxInfoFieldBytes < 3) {
    throw new RangeError(
      "maxInfoFieldBytes must be at least 3 for the inner-PID format (1 byte F/X control + 1 byte inner PID + at least 1 byte of payload on the first segment)",
    );
  }

  const perSegment = maxInfoFieldBytes - 1; // subsequent-segment data capacity (F/X + data)
  const firstSegmentCapacity = maxInfoFieldBytes - 2; // first-segment data capacity (F/X + inner PID + data)

  // Count of segments, treating the inner-PID octet as one extra payload byte
  // that consumes a data slot — mirrors Dire Wolf's DIVROUNDUP(len + 1, N1 - 1).
  // For an empty payload, one segment still carries the inner PID.
  const budget = payload.length + 1;
  let segmentCount = Math.ceil(budget / perSegment);
  if (segmentCount < 1) segmentCount = 1;
  if (segmentCount > SEGMENT_MAX_SEGMENTS) {
    throw new RangeError(
      `payload of ${payload.length} bytes (plus 1 inner-PID octet) would need ${segmentCount} segments at N1=${maxInfoFieldBytes}; max is ${SEGMENT_MAX_SEGMENTS}`,
    );
  }

  const result: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < segmentCount; i++) {
    const remaining = segmentCount - 1 - i;
    if (i === 0) {
      const thisLen = Math.min(firstSegmentCapacity, payload.length - offset);
      const out = new Uint8Array(2 + Math.max(thisLen, 0));
      out[0] = SEGMENT_FIRST_BIT | (remaining & SEGMENT_COUNT_MASK);
      out[1] = innerPid & 0xff;
      if (thisLen > 0) out.set(payload.subarray(offset, offset + thisLen), 2);
      result.push(out);
      offset += thisLen;
    } else {
      const thisLen = Math.min(perSegment, payload.length - offset);
      const out = new Uint8Array(1 + Math.max(thisLen, 0));
      out[0] = remaining & SEGMENT_COUNT_MASK;
      if (thisLen > 0) out.set(payload.subarray(offset, offset + thisLen), 1);
      result.push(out);
      offset += thisLen;
    }
  }
  return result;
}

/**
 * AX.25 v2.2 §6.6 reassembly — accumulates a sequence of segments (each pushed
 * as the info field of one I-frame with PID 0x08) into a single upper-layer
 * payload. Mirrors the C# `Reassembler`.
 *
 * One {@link Reassembler} handles one in-flight multi-segment payload at a
 * time. A new "First" segment discards any previously accumulated partial state
 * — matching the spec's behaviour when a fresh packet arrives mid-way through a
 * prior series.
 *
 * ## Inner PID (de-facto-interop format)
 *
 * When constructed with `expectInnerPid: true`, the reassembler reads an
 * inner-PID octet off the front of the first segment's data (Dire Wolf's format
 * — see {@link segment}) and exposes it via {@link Reassembler.lastRecoveredPid},
 * so the reassembled payload can be delivered with its original Layer-3 PID.
 * When constructed with `expectInnerPid: false` (figure-literal, the default),
 * there is no inner PID and {@link Reassembler.lastRecoveredPid} stays `null`.
 */
export class Reassembler {
  private readonly accumulated: Uint8Array[] = [];
  private expectedRemaining = -1; // -1 = waiting for a "First" segment
  private readonly expectInnerPid: boolean;
  private pendingPid: number | null = null; // inner PID seen on the current series' first segment

  /**
   * The original Layer-3 PID recovered from the inner-PID octet of the most
   * recently *completed* series, when this reassembler expects the inner-PID
   * format. `null` for the figure-literal format (no inner PID is carried), or
   * before any series has completed. Mirrors C#'s `LastRecoveredPid`.
   */
  lastRecoveredPid: number | null = null;

  /**
   * @param expectInnerPid When `true`, read an inner-PID octet off the first
   *   segment (Dire Wolf's format) and surface it via
   *   {@link Reassembler.lastRecoveredPid}. When `false` (default), the
   *   figure-literal format (no inner PID).
   */
  constructor(expectInnerPid = false) {
    this.expectInnerPid = expectInnerPid;
  }

  /**
   * Push the info-field bytes of one segment. Returns the completed payload
   * when the last segment of a series arrives (remaining count == 0); returns
   * `null` when more segments are expected. On completion,
   * {@link Reassembler.lastRecoveredPid} holds the inner PID (inner-PID format)
   * or `null` (figure-literal format).
   *
   * @throws {SegmentReassemblyError} if `infoField` is empty, or — for the
   *   inner-PID format — a first segment lacks the inner-PID octet, or a
   *   non-First segment arrives without a prior First, or the remaining count
   *   is out of sequence vs. the prior segment. This is the reassembler's
   *   strict, documented contract; the wire-facing {@link SegmentationLayer}
   *   catches it narrowly and drops the bad segment cleanly.
   */
  push(infoField: Uint8Array): Uint8Array | null {
    if (infoField.length < 1) {
      throw new SegmentReassemblyError(
        "segment info field must be at least 1 byte (the control byte)",
      );
    }

    const header = infoField[0];
    const isFirst = (header & SEGMENT_FIRST_BIT) !== 0;
    const remaining = header & SEGMENT_COUNT_MASK;

    let data: Uint8Array;
    if (isFirst && this.expectInnerPid) {
      if (infoField.length < 2) {
        throw new SegmentReassemblyError(
          "first segment of an inner-PID series must be at least 2 bytes (the F/X control byte + the inner-PID octet)",
        );
      }
      this.pendingPid = infoField[1];
      data = infoField.subarray(2);
    } else {
      data = infoField.subarray(1);
    }

    if (isFirst) {
      this.accumulated.length = 0;
      this.expectedRemaining = remaining;
      if (!this.expectInnerPid) this.pendingPid = null;
    } else if (this.expectedRemaining < 0) {
      throw new SegmentReassemblyError(
        "non-First segment received before any First segment — no in-progress reassembly to attach to",
      );
    } else if (remaining !== this.expectedRemaining - 1) {
      throw new SegmentReassemblyError(
        `segment count out of sequence: expected ${this.expectedRemaining - 1}, got ${remaining}`,
      );
    } else {
      this.expectedRemaining = remaining;
    }

    // Copy out of the (possibly aliased) info-field view so a caller reusing
    // the source buffer can't corrupt accumulated state.
    this.accumulated.push(Uint8Array.from(data));

    if (remaining !== 0) return null;

    let totalLen = 0;
    for (const chunk of this.accumulated) totalLen += chunk.length;
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.accumulated) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.accumulated.length = 0;
    this.expectedRemaining = -1;
    this.lastRecoveredPid = this.pendingPid;
    this.pendingPid = null;
    return out;
  }
}
