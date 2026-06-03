/**
 * AX.25 v2.2 §2.4 / §6.6 segmentation-reassembly shim — the TS analogue of
 * packet.net's `SegmentationLayer` (`src/Packet.Ax25/Session/SegmentationLayer.cs`).
 * It sits at the data-link primitive boundary — between Layer 3 (the upper
 * layer) and a session — and the data-link state machine / session stay
 * **unchanged**: segments travel as ordinary I-frames carrying PID
 * {@link PID_SEGMENTED} (0x08), so the FSM just sends and receives them. This
 * layer is the §6.6 "the segmenter passes all other signals unchanged" boundary
 * process.
 *
 * One instance per data-link session — it owns the per-session
 * {@link Reassembler} (which holds in-flight multi-segment state). The spec
 * models exactly this placement (§2557 / §2560): the reassembler examines the
 * DL-DATA / DL-UNIT-DATA *indication* (a 0x08 PID means reassemble, anything
 * else passes through transparently); the segmenter examines the DL-DATA /
 * DL-UNIT-DATA *request* (over-N1 means segment, otherwise pass through).
 *
 * ## Gating
 *
 * Segmentation is a v2.2, negotiated capability (§1621 — "only enabled if both
 * stations on the link are using AX.25 version 2.2 or higher", set via the XID
 * HDLC-Optional-Functions segmenter bit). This layer gates the send side on
 * {@link Ax25SessionContext.segmenterReassemblerEnabled} (V3's MDL negotiation
 * sets it). If a payload exceeds N1 and the segmenter is *not* enabled,
 * {@link SegmentationLayer.buildSendRequests} throws — the request is rejected
 * cleanly rather than silently truncated or sent as an oversize frame.
 *
 * ## Inner PID on reassembly — gated by {@link Ax25SessionQuirks.segmentFirstCarriesL3Pid} (default on)
 *
 * Figure 6.2 defines the segment header as the 0x08 PID octet plus one F/X
 * octet — there is **no field carrying the original Layer-3 PID** through a
 * segmented series. Dire Wolf, the only known v2.2 segmenter, prepends the
 * original PID as an extra octet on the first segment so its reassembler can
 * recover it (the §6.6 "two-octet header" prose admits this reading). This shim
 * matches Dire Wolf by **default**:
 *
 *  - **Quirk on (default):** the first segment carries the inner-PID octet
 *    ({@link segment} writes it on send; the {@link Reassembler} reads it on
 *    receive). A reassembled payload is delivered with that **original L3 PID**
 *    — so segmentation no longer loses it.
 *  - **Quirk off ({@link strictlyFaithfulSessionQuirks}):** the figure-literal
 *    format — no inner-PID octet, and a reassembled payload is delivered as
 *    {@link PID_NO_LAYER_3} (0xF0), the faithful "PID unknown / raw" value
 *    ({@link SegmentationLayer.figureLiteralReassembledPid}).
 *
 * The quirk is read **lazily** (at first send/receive): callers such as
 * {@link Ax25Listener} construct the shim before their `configureSession` hook
 * has set {@link Ax25SessionContext.quirks}. Mirrors C#'s `SegmentationLayer`
 * (packet.net#279).
 */
import { PID_NO_LAYER_3, PID_SEGMENTED } from "../frame.js";
import { type Ax25Event, dlDataRequestEvent } from "./events.js";
import type { Ax25SessionContext } from "./session-context.js";
import { Reassembler, SegmentReassemblyError, segment } from "./segmenter.js";

/**
 * A DL-DATA-indication {@link DataLinkSignal} — the narrowed shape the receive
 * shim consumes and produces. (`DataLinkSignal` is a tagged union; this is the
 * `"DL_DATA_indication"` arm.) Re-declared locally to keep the type narrow at
 * the shim boundary; structurally identical to the union member.
 */
export interface DataLinkDataIndication {
  readonly type: "DL_DATA_indication";
  readonly data: Uint8Array;
  readonly pid: number;
}

export class SegmentationLayer {
  private readonly context: Ax25SessionContext;
  private reassembler: Reassembler | null = null;

  /**
   * PID delivered with a reassembled payload under the *figure-literal* format
   * (the {@link Ax25SessionQuirks.segmentFirstCarriesL3Pid} quirk off). Per §6.6
   * / Figure 6.2 the segment header carries no inner Layer-3 PID, so
   * figure-literal reassembled data is delivered as {@link PID_NO_LAYER_3}
   * (0xF0). With the quirk on (default) the inner-PID octet recovers the
   * original L3 PID instead. Mirrors the C#
   * `SegmentationLayer.FigureLiteralReassembledPid`.
   */
  static readonly figureLiteralReassembledPid = PID_NO_LAYER_3;

  /**
   * @param context The session's context — read for the negotiated
   *   segmenter-enabled flag, N1, and the segmentation-format quirk. The quirk
   *   is read *lazily* (at first send/receive), because callers such as
   *   {@link Ax25Listener} construct the shim before their `configureSession`
   *   hook has set {@link Ax25SessionContext.quirks}.
   */
  constructor(context: Ax25SessionContext) {
    this.context = context;
  }

  /**
   * Whether the Dire-Wolf first-segment inner-PID format is in effect for this
   * session — read live from the context's quirks (default on). Mirrors C#'s
   * `InnerPidFormat`.
   */
  private get innerPidFormat(): boolean {
    return this.context.quirks.segmentFirstCarriesL3Pid;
  }

  /**
   * Send-side shim. Given an upper-layer payload + its Layer-3 PID, return the
   * sequence of `DL_DATA_request` {@link Ax25Event}s to post to the session:
   *
   *  - If the segmenter is enabled and the payload exceeds N1, one
   *    `DL_DATA_request` per segment, each carrying PID {@link PID_SEGMENTED}
   *    (0x08); the session enqueues + sends each as a normal I-frame.
   *  - Otherwise a single `DL_DATA_request` with the original payload + PID,
   *    unchanged.
   *
   * @throws Error if the payload exceeds N1 and the segmenter has not been
   *   negotiated (v2.0 / not enabled) — the request can't be honoured without
   *   violating N1, so it is rejected cleanly. Mirrors the C#
   *   `InvalidOperationException`.
   */
  buildSendRequests(data: Uint8Array, pid: number = PID_NO_LAYER_3): Ax25Event[] {
    // N1 is the max info-field octet count. An un-segmented info field is the
    // whole payload (one PID, no segment-control byte), so the pass-through
    // ceiling is N1 itself. A *segment's* info field is the F/X control byte +
    // payload, so per-segment payload is N1−1.
    const fits = data.length <= this.context.n1;

    if (fits) {
      return [dlDataRequestEvent(data, pid)];
    }

    if (!this.context.segmenterReassemblerEnabled) {
      throw new Error(
        `payload of ${data.length} bytes exceeds N1=${this.context.n1} and the ` +
          "segmenter/reassembler has not been negotiated (AX.25 v2.2 §6.6 — segmentation requires " +
          "both peers to advertise the XID HDLC-Optional-Functions segmenter bit). Cannot send " +
          "without segmenting; rejecting the request rather than truncating or producing an " +
          "oversize frame.",
      );
    }

    // Segment into PID-0x08 info fields and post each as its own I-frame
    // request. With the inner-PID quirk on (default), the first segment also
    // carries the original L3 PID after the F/X byte (Dire Wolf's format) so the
    // receiver can recover it; with the quirk off (strictlyFaithful) the
    // figure-literal format is emitted (no inner PID).
    return segment(
      data,
      this.context.n1,
      this.innerPidFormat ? pid : undefined,
    ).map((seg) => dlDataRequestEvent(seg, PID_SEGMENTED));
  }

  /**
   * Receive-side shim. Given a `DL_DATA_indication` the session raised, either:
   *
   *  - If its PID is {@link PID_SEGMENTED} (0x08), feed the info field to the
   *    per-session {@link Reassembler} and return the completed payload as a
   *    single reassembled `DL_DATA_indication` on the last segment, or `null`
   *    while more segments are expected (nothing to deliver yet).
   *  - Otherwise return the indication unchanged (pass-through).
   *
   * **Malformed / protocol-violating segments are dropped cleanly at this
   * seam.** The wire is untrusted: a hostile peer or RF corruption can deliver
   * a PID-0x08 indication that is empty, a non-First segment with no prior
   * First, an inner-PID First missing its PID octet, or an out-of-sequence
   * continuation. {@link Reassembler.push} rejects each of these by throwing a
   * {@link SegmentReassemblyError} (its strict, documented contract). This
   * boundary process is the right place to turn that strict contract into a
   * graceful drop: it catches the {@link SegmentReassemblyError}, **resets any
   * in-progress reassembly** (so a corrupt series can't poison the next valid
   * one — the discarded reassembler is rebuilt lazily on the next segment, back
   * in the "waiting for a First" state), and returns `null` — the same "nothing
   * to deliver yet" signal as a legitimate mid-series segment. Nothing
   * propagates to the caller and nothing relies on {@link Ax25Listener}'s
   * inbound catch-all. This matches the §6.6 / Fig C5.2 reassembler treating a
   * bad segment as a discardable error, and Dire Wolf (the only known v2.2
   * segmenter), whose reassembler logs a "Reassembler Protocol Error" and
   * drops. Only `push`'s documented {@link SegmentReassemblyError} is caught —
   * any other (crash-class) error is deliberately left to surface. The clean
   * drop is **unconditional**, not quirk-gated: the strict/faithful quirk
   * governs the segment *wire format*, not hostile-input tolerance. Mirrors
   * packet.net#284.
   *
   * The low-level {@link Reassembler.push} contract is deliberately *unchanged*
   * — direct callers still get the strict throw; only this wire-facing seam
   * softens it to a drop.
   *
   * @returns The indication to deliver upward, or `null` when a segment was
   *   consumed but the series is incomplete — or when a malformed segment was
   *   dropped (and the reassembler reset). Mirrors the C#
   *   `SegmentationLayer.OnDataIndication`.
   */
  onDataIndication(
    indication: DataLinkDataIndication,
  ): DataLinkDataIndication | null {
    if (indication.pid !== PID_SEGMENTED) {
      return indication; // not a segment — pass through transparently
    }

    // Construct the per-session reassembler lazily on first use, reading the
    // segmentation-format quirk live (the context's quirks may have been set by
    // a configureSession hook that ran after this shim was constructed).
    this.reassembler ??= new Reassembler(this.innerPidFormat);

    let completed: Uint8Array | null;
    try {
      completed = this.reassembler.push(indication.data);
    } catch (err) {
      if (err instanceof SegmentReassemblyError) {
        // Malformed / protocol-violating segment off the wire. Drop it cleanly
        // and discard any partially-accumulated series so a corrupt run can't
        // poison the next valid one — the dropped reassembler is replaced lazily
        // on the next segment, back in the "waiting for a First" state. We
        // swallow *only* push's documented contract error; any other
        // (crash-class) error would be a genuine bug and is left to surface.
        this.reassembler = null;
        return null;
      }
      throw err;
    }
    if (completed === null) return null; // mid-series segment — nothing to deliver yet

    // With the inner-PID quirk on, the reassembler recovered the original L3 PID
    // off the first segment — deliver with it. With the quirk off
    // (figure-literal) there is no inner PID, so deliver as PID_NO_LAYER_3.
    const pid =
      this.reassembler.lastRecoveredPid ??
      SegmentationLayer.figureLiteralReassembledPid;
    return { type: "DL_DATA_indication", data: completed, pid };
  }
}
