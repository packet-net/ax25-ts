import type { Callsign } from "../callsign.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
} from "./session-quirks.js";

/**
 * Mutable per-session state for one AX.25 data-link connection. Mirrors
 * the C# `Ax25SessionContext` field-for-field — the SDL action dispatcher
 * reads / writes these fields, and the {@link Ax25SessionBindings} closures
 * read flags / sequence variables to evaluate guards.
 *
 * Field names follow the spec's variable names (V(S), V(A), V(R), etc.)
 * verbatim. The same modulus rules apply: mod-8 uses the low 3 bits of the
 * byte values; mod-128 uses all 7. {@link isExtended} flips between the two —
 * the sequence arithmetic ({@link modulus} / {@link incrementSeq}) and the
 * I/S frame codec are both mode-aware (v2.2 arc V1). The driver doesn't yet
 * *negotiate* mod-128 on its own (it doesn't flip {@link isExtended} from an
 * inbound SABME); a caller wanting an extended link sets it directly.
 */
export interface Ax25SessionContext {
  /** Our station identity. */
  local: Callsign;
  /** Remote station identity. */
  remote: Callsign;

  // ─── Sequence variables (§4.2.2) ────────────────────────────────────

  /** V(S) — send state variable. */
  vs: number;
  /** V(A) — last acknowledged sent I-frame. */
  va: number;
  /** V(R) — receive state variable. */
  vr: number;
  /** Retry counter (RC) — outstanding-poll retransmits. */
  rc: number;

  // ─── Flags (§C4.3) ──────────────────────────────────────────────────

  /** Layer 3 is busy and cannot receive I frames. */
  ownReceiverBusy: boolean;
  /** Remote station is busy. */
  peerReceiverBusy: boolean;
  /** I frames have been received but not yet acknowledged. */
  acknowledgePending: boolean;
  /** REJ has been sent to the remote (mod-8 implicit reject). */
  rejectException: boolean;
  /** SREJ has been sent to the remote. */
  selectiveRejectException: boolean;
  /** Count of outstanding SREJ exceptions per §C4.3. */
  srejExceptionCount: number;
  /** SABM(E) was sent by request of Layer 3 (DL-CONNECT request). */
  layer3Initiated: boolean;

  /**
   * Node-policy flag — when `true` (the default), the session accepts
   * inbound SABM/SABME frames and runs the figc4.1 t14 / figc4.1 t13
   * acceptance path. When `false`, figc4.1's `able_to_establish?`
   * decision falls through to the No branch (t15) which emits DM and
   * stays Disconnected.
   *
   * Per-session because in deployments with multiple sessions on one
   * modem the policy genuinely differs per peer — a node that has
   * already accepted one connection still wants the default for
   * unrelated peer sessions. The {@link Ax25Listener} flips this flag
   * on a transient session it has chosen to reject so the SDL t15
   * path emits DM without any wrapper closure.
   */
  acceptIncoming: boolean;

  /** Saved V(s) for figc4.7's Invoke_Retransmission loop, or null. */
  x: number | null;
  /** True if T1 fired at least once since last Select_T1_Value. */
  t1HadExpired: boolean;
  /** Captured T1 remaining at stop_T1, in ms. Zero on fresh session. */
  t1RemainingWhenLastStoppedMs: number;

  // ─── Negotiated link parameters (§6.7.2, XID defaults) ───────────────

  /** Maximum information field length in octets (N1). Default 256. */
  n1: number;
  /** Maximum number of retries (N2). Default 10. */
  n2: number;
  /** Maximum outstanding I frames (k). Default 4 (mod-8) / 32 (mod-128). */
  k: number;
  /** True for mod-128 (SABME / extended); false for mod-8 (SABM). */
  isExtended: boolean;
  /** True if SREJ has been negotiated via XID. */
  srejEnabled: boolean;
  /**
   * True if the segmenter/reassembler has been negotiated via XID (the HDLC
   * Optional Functions segmenter bit, §4.3.3.7) — a v2.2-only capability
   * (§1419) enabled only when both peers advertise it. The MDL negotiation sets
   * this; forced off on the version-2.0 fallback. Mirrors the C#
   * `Ax25SessionContext.SegmenterReassemblerEnabled`. (The DL-DATA
   * segment/reassemble path that gates on it is a later arc.)
   */
  segmenterReassemblerEnabled: boolean;
  /** True for half-duplex operation. */
  halfDuplex: boolean;
  /** True if implicit-reject scheme (v2.0); false for selective-reject (v2.2). */
  implicitReject: boolean;
  /** Acknowledgement-timer T2 duration in ms. Default 3000. */
  t2Ms: number;
  /** Smoothed Round-Trip Time per §6.7.1.2, in ms. Default 3000. */
  srtMs: number;
  /** T1 timeout value per §6.7.1.3, in ms. Default 6000 (= 2 * SRT). */
  t1vMs: number;

  /**
   * Named deviations from the SDL figures where a figure is a confirmed
   * upstream spec defect (see {@link Ax25SessionQuirks}). Defaults to the
   * spec-correct behaviour ({@link defaultSessionQuirks}); set
   * {@link strictlyFaithfulSessionQuirks} to run the figures exactly as
   * drawn for conformance testing.
   */
  quirks: Ax25SessionQuirks;

  // ─── Queues ─────────────────────────────────────────────────────────

  /** FIFO queue of I-frame payloads awaiting transmission. */
  iFrameQueue: { data: Uint8Array; pid: number }[];

  /** Map of N(S) → I-frame payload + PID for retransmission. */
  sentIFrames: Map<number, { data: Uint8Array; pid: number }>;

  /** Out-of-sequence received I-frames keyed by N(S). */
  storedReceivedIFrames: Map<number, { info: Uint8Array; pid: number }>;

  /**
   * N(S) values that have already been selectively retransmitted (in response
   * to an SREJ) since V(a) last advanced — i.e. within the current recovery
   * cycle. A burst of redundant SREJs for the same still-outstanding gap (the
   * figc4.4 over-SREJ: one SREJ per out-of-sequence frame) must not spawn one
   * wire copy each — the surplus copies become stale once the receiver's V(R)
   * wraps past them and get mis-delivered as new (the mod-8 SREJ ring-wrap
   * duplicate; M0LTE/packet.net#285). Cleared on every V(a) advance (genuine
   * progress = new cycle, see {@link pruneAcknowledgedSentIFrames}) and per-N(S)
   * when a fresh I-frame is emitted at that N(S). A genuinely lost retransmit is
   * still recovered — via the T1/TimerRecovery `Invoke_Retransmission` path,
   * which does not consult this set. direwolf reaches the same effect by
   * deleting acknowledged `txdata_by_ns[ns]` + de-duplicating SREJ requests
   * (ax25_link.c). Mirrors the C# `Ax25SessionContext.SelectivelyRetransmittedSinceAck`.
   */
  selectivelyRetransmittedSinceAck: Set<number>;
}

/** Modulus used for sequence-variable arithmetic (8 or 128). */
/**
 * The window (k) the engine actually enforces for BOTH the send side (max
 * outstanding I-frames) and the receive side (the in-window acceptance bound for
 * storing out-of-sequence frames) — {@link Ax25SessionContext.k}, but capped at
 * `modulus/2` while Selective Repeat ({@link Ax25SessionContext.srejEnabled}) is
 * in effect, per the Selective-Repeat window-wrap invariant (ax25spec#13). Above
 * that cap, two in-flight frames could share an N(S) and SREJ recovery can
 * silently deliver a stale stored frame (m0lte/packet.net#393). Gated by
 * {@link Ax25SessionQuirks.ax25Spec13ClampSrejWindowToHalfModulus} (default on);
 * with the quirk off it is just `k`, reproducing the unbounded figure-literal
 * behaviour. Go-back-N links (SREJ off) are never capped.
 */
export function effectiveWindow(ctx: Ax25SessionContext): number {
  return ctx.quirks.ax25Spec13ClampSrejWindowToHalfModulus && ctx.srejEnabled
    ? Math.min(ctx.k, Math.floor(modulus(ctx) / 2))
    : ctx.k;
}

export function modulus(ctx: Ax25SessionContext): number {
  return ctx.isExtended ? 128 : 8;
}

/** Increment a sequence variable, wrapping at modulus. */
export function incrementSeq(ctx: Ax25SessionContext, value: number): number {
  return (value + 1) % modulus(ctx);
}

export function decrementSeq(ctx: Ax25SessionContext, value: number): number {
  return (value + modulus(ctx) - 1) % modulus(ctx);
}

/**
 * True if `ns` is an *outstanding* (sent-but-not-yet-acknowledged) send sequence
 * number — i.e. it lies in the half-open window `[V(a), V(s))` in mod-N
 * arithmetic. A frame whose N(S) is outside this window has already been
 * acknowledged (behind V(a)) or was never sent (at/after V(s)); replaying it
 * during recovery would put a stale sequence number on the wire that the peer
 * can mis-deliver once its V(R) has wrapped past it (the mod-8 SREJ ring-wrap
 * duplicate; M0LTE/packet.net#285). Mirrors the C# `Ax25SessionContext.IsOutstanding`.
 */
export function isOutstanding(ctx: Ax25SessionContext, ns: number): boolean {
  const m = modulus(ctx);
  const span = (ctx.vs - ctx.va + m) % m; // count of outstanding frames
  const offset = (ns - ctx.va + m) % m; // position of ns within the window
  return offset < span;
}

/**
 * Drop every entry in {@link Ax25SessionContext.sentIFrames} whose N(S) is no
 * longer outstanding (i.e. has been acknowledged — it now lies behind V(a) per
 * {@link isOutstanding}). Called whenever V(a) advances so a stale or duplicate
 * REJ/SREJ cannot make the recovery path replay an already-acked frame. Mirrors
 * direwolf's `cdata_delete(txdata_by_ns[...])` on acknowledgement (ax25_link.c),
 * and the C# `Ax25SessionContext.PruneAcknowledgedSentIFrames`.
 */
export function pruneAcknowledgedSentIFrames(ctx: Ax25SessionContext): void {
  if (ctx.sentIFrames.size === 0) return;
  for (const ns of [...ctx.sentIFrames.keys()]) {
    if (!isOutstanding(ctx, ns)) ctx.sentIFrames.delete(ns);
  }
}

/** Build a fresh session context for a `(local, remote)` pair. */
export function createSessionContext(
  local: Callsign,
  remote: Callsign,
): Ax25SessionContext {
  return {
    local,
    remote,
    quirks: { ...defaultSessionQuirks },
    vs: 0,
    va: 0,
    vr: 0,
    rc: 0,
    ownReceiverBusy: false,
    peerReceiverBusy: false,
    acknowledgePending: false,
    rejectException: false,
    selectiveRejectException: false,
    srejExceptionCount: 0,
    layer3Initiated: false,
    acceptIncoming: true,
    x: null,
    t1HadExpired: false,
    t1RemainingWhenLastStoppedMs: 0,
    n1: 256,
    n2: 10,
    k: 4,
    isExtended: false,
    srejEnabled: false,
    segmenterReassemblerEnabled: false,
    halfDuplex: true,
    implicitReject: true,
    t2Ms: 3000,
    srtMs: 3000,
    t1vMs: 6000,
    iFrameQueue: [],
    sentIFrames: new Map(),
    storedReceivedIFrames: new Map(),
    selectivelyRetransmittedSinceAck: new Set(),
  };
}

/** Reset session state to freshly-connected defaults. Used by SABM/SABME paths. */
export function resetState(ctx: Ax25SessionContext): void {
  ctx.vs = 0;
  ctx.va = 0;
  ctx.vr = 0;
  ctx.rc = 0;
  ctx.ownReceiverBusy = false;
  ctx.peerReceiverBusy = false;
  ctx.acknowledgePending = false;
  ctx.rejectException = false;
  ctx.selectiveRejectException = false;
  ctx.srejExceptionCount = 0;
  ctx.layer3Initiated = false;
  ctx.x = null;
  ctx.t1HadExpired = false;
  ctx.t1RemainingWhenLastStoppedMs = 0;
  ctx.iFrameQueue.length = 0;
  ctx.sentIFrames.clear();
  ctx.storedReceivedIFrames.clear();
  ctx.selectivelyRetransmittedSinceAck.clear();
}
