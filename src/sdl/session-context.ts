import type { Callsign } from "../callsign.js";

/**
 * Mutable per-session state for one AX.25 data-link connection. Mirrors
 * the C# `Ax25SessionContext` field-for-field — the SDL action dispatcher
 * reads / writes these fields, and the {@link Ax25SessionBindings} closures
 * read flags / sequence variables to evaluate guards.
 *
 * Field names follow the spec's variable names (V(S), V(A), V(R), etc.)
 * verbatim. The same modulus rules apply: mod-8 uses the low 3 bits of
 * the byte values; mod-128 would use all 7. {@link IsExtended} flips
 * between the two. (mod-128 isn't wired in the TS dispatcher — see the
 * README "What's in / what's out" table.)
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

  // ─── Queues ─────────────────────────────────────────────────────────

  /** FIFO queue of I-frame payloads awaiting transmission. */
  iFrameQueue: { data: Uint8Array; pid: number }[];

  /** Map of N(S) → I-frame payload + PID for retransmission. */
  sentIFrames: Map<number, { data: Uint8Array; pid: number }>;

  /** Out-of-sequence received I-frames keyed by N(S). */
  storedReceivedIFrames: Map<number, { info: Uint8Array; pid: number }>;
}

/** Modulus used for sequence-variable arithmetic (8 or 128). */
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

/** Build a fresh session context for a `(local, remote)` pair. */
export function createSessionContext(
  local: Callsign,
  remote: Callsign,
): Ax25SessionContext {
  return {
    local,
    remote,
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
    halfDuplex: true,
    implicitReject: true,
    t2Ms: 3000,
    srtMs: 3000,
    t1vMs: 6000,
    iFrameQueue: [],
    sentIFrames: new Map(),
    storedReceivedIFrames: new Map(),
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
}
