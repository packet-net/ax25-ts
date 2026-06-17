import { Callsign } from "./callsign.js";
import {
  type Ax25Frame,
  type Ax25ParseOptions,
  LENIENT_PARSE,
  PID_NO_LAYER_3,
  classify,
  decodeFrame,
  encodeFrame,
  isCommand as frameIsCommand,
  pollFinal as framePollFinal,
  test,
  ui,
} from "./frame.js";
import type { DataLinkSignal, MdlSignal } from "./sdl/action-dispatcher.js";
import type { Ax25Event } from "./sdl/events.js";
import { classifyFrame } from "./sdl/frame-classifier.js";
import { Ax25ManagementDataLink } from "./sdl/management-data-link.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "./sdl/session-context.js";
import { SdlSessionDriver } from "./sdl/session-driver.js";
import type { Ax25SessionQuirks } from "./sdl/session-quirks.js";
import { SegmentationLayer } from "./sdl/segmentation-layer.js";
import { RealTimerScheduler, type TimerScheduler } from "./sdl/timer-scheduler.js";
import type { Ax25Transport } from "./transport.js";

/**
 * Options for {@link Ax25Listener}. `myCall` is required; everything else
 * has a sensible default that matches the AX.25 v2.2 spec.
 */
export interface Ax25ListenerOptions {
  /** Local callsign. Inbound frames not addressed here are ignored at the session layer. */
  myCall: Callsign | string;
  /**
   * Override the session-context default T1V (acknowledgement timer).
   * If omitted, sessions use the spec default (6 s = 2 × initial SRT);
   * figc4.7's `Select_T1_Value` would recompute the running value
   * dynamically — the TS dispatcher stubs that subroutine so the static
   * value sticks.
   */
  t1Ms?: number;
  /** Override the session-context default T2 (response-delay timer). Default 1500 ms. */
  t2Ms?: number;
  /** Override the dispatcher's T3 (inactive-link) timer duration. Default 30 000 ms. */
  t3Ms?: number;
  /** Override the spec-default N2 (max retries; default 10). */
  n2?: number;
  /** Override the spec-default k (send-window size; default 4 for mod-8). */
  k?: number;
  /**
   * LRU cap on cached per-peer sessions. Default 64 — most node deployments
   * sit well within that; the cap is a memory safety belt to keep a
   * misbehaving / spam-SABM peer from creating unbounded sessions.
   */
  maxCachedPeers?: number;
  /**
   * Wire-parse options for this listener's *inbound* frames. If omitted, the
   * listener uses {@link LENIENT_PARSE} — the historical behaviour. Pass
   * {@link STRICT_PARSE} for spec-exact acceptance, or a peer preset
   * ({@link BPQ_PARSE} etc.) to match a known neighbour. A frame the options
   * reject is dropped before tracing or dispatch — the listener is deaf to it,
   * exactly as if it had failed CRC. Outbound construction is unaffected
   * (frames we build are always strict). Mirrors C#
   * `Ax25ListenerOptions.ParseOptions` (packet.net#366).
   */
  parseOptions?: Ax25ParseOptions;

  /**
   * SDL figure-defect / de-facto-interop quirks seeded onto each new
   * session's context. If omitted, sessions use the spec-correct defaults
   * (`defaultSessionQuirks`). Pass `strictlyFaithfulQuirks` to run the SDL
   * figures exactly as drawn, defects included — conformance study only, not
   * for on-air use. Mirrors C# `Ax25ListenerOptions.Quirks` (packet.net#366).
   */
  quirks?: Ax25SessionQuirks;

  /**
   * Prefer AX.25 v2.2 on every outbound {@link Ax25Listener.connect}: when
   * `true` (default), a dial initiates an **extended (SABME / mod-128)** connect
   * (the inlined `Establish_Data_Link` branches on `isExtended` and emits SABME),
   * with XID negotiating SREJ + window after the UA, and degrades cleanly to
   * v2.0/SABM for peers that can't — a v2.2-incapable peer that answers our SABME
   * with FRMR (LinBPQ) falls back via
   * {@link Ax25SessionQuirks.ax25Spec45FrmrFallbackReestablishesV20}, and one that
   * answers with DM (XRouter) falls back via
   * {@link Ax25SessionQuirks.ax25Spec48DmRejectionDegradesToV20} — so a dial never
   * fails against a non-v2.2 peer. When `false`, a dial initiates a plain v2.0
   * (SABM / mod-8) connect, the historical behaviour.
   *
   * Affects the *outbound* dial only — the inbound answerer is untouched and
   * still adopts whatever the peer offers (an inbound SABM runs `set_version_2_0`,
   * an inbound SABME runs `set_version_2_2`, per figc4.1). A per-call override is
   * available on {@link Ax25Listener.connect}'s `extended` argument. Mirrors C#
   * `Ax25ListenerOptions.PreferExtendedConnect`.
   */
  preferExtendedConnect?: boolean;

  /**
   * On a **mod-8 / v2.0** outbound dial (a v2.0-preferred connect, or the mod-8
   * link a v2.2 dial degraded to), run an **XID command/response exchange BEFORE
   * the SABM** to negotiate Selective Reject (SREJ). When `true` (default), the
   * dial first puts an XID command on the wire advertising SREJ + SREJ-multiframe
   * at mod-8; if the peer answers with an XID response that also offers SREJ, the
   * link runs SREJ recovery (selective retransmit) instead of go-back-N. If the
   * peer does not answer XID (or rejects it), the dial proceeds to a plain SABM
   * and the link is go-back-N — so this is always safe to leave on.
   *
   * This is the **LinBPQ SREJ accommodation**, proven on the wire (packet.net's
   * `SrejXidViaNetsim`): LinBPQ does mod-8 SREJ but only when an XID *precedes*
   * the SABM (its `L2Code.c` `ProcessXIDCommand` runs on the no-active-link path
   * and sets `LINK->Ver2point2`; an XID on an already-established link is
   * ignored). The AX.25 v2.2 figures instead negotiate XID *after* the connect
   * (figc4.6 raises MDL-NEGOTIATE on the UA), which is what we do on the
   * v2.2/SABME path — but that post-connect XID never reaches BPQ's responder. So
   * speaking SREJ to BPQ specifically needs the pre-SABM exchange; this knob
   * enables it for the mod-8 dial. Affects the *outbound* dial only. Mirrors C#
   * `Ax25ListenerOptions.PreConnectXidNegotiatesSrej`.
   */
  preConnectXidNegotiatesSrej?: boolean;

  /**
   * Optional hook called once per newly-built session, before any events
   * flow into it. Use to attach onData / onDisconnect handlers on the
   * session's signal stream before the SDL processes the inbound SABM
   * that triggered session creation.
   */
  configureSession?: (session: Ax25ListenerSession) => void;
  /**
   * Optional sink for event-handler exceptions. The listener wraps every
   * `sessionAccepted` / `frameTraced` dispatch in try/catch so a buggy
   * subscriber can't DoS the inbound pump; exceptions go here. Defaults
   * to `console.error`.
   */
  onHandlerError?: (err: unknown) => void;
}

/** Direction tag for a frame as it crosses the listener-transport boundary. */
export type FrameDirection = "tx" | "rx";

/** Payload for the `frameTraced` event. */
export interface Ax25FrameTracedEvent {
  readonly frame: Ax25Frame;
  readonly direction: FrameDirection;
  readonly timestamp: Date;
}

/**
 * One AX.25 session managed by a listener — built on top of the SDL
 * session driver, identical in shape to a session inside `Ax25Stack`
 * (except the listener owns the inbound pump rather than the
 * outbound-only `connect()` factory).
 *
 * Listener-built sessions don't have an `_initiateConnect` / `_handleFrame`
 * surface — the listener feeds events directly via {@link postEvent}.
 * Public surface for consumers:
 *
 *   - {@link state}, {@link context} — read-only inspection
 *   - {@link postEvent} — push DL primitives (DL_CONNECT_request,
 *     DL_DISCONNECT_request, DL_DATA_request) at the session
 *   - {@link onDataLinkSignal} — subscribe to upward signals
 *     (DL_CONNECT_confirm, DL_DATA_indication, DL_DISCONNECT_indication,
 *     DL_ERROR_indication, …) emitted by the SDL action chain
 *   - {@link offDataLinkSignal} — unsubscribe
 */
export class Ax25ListenerSession {
  readonly context: Ax25SessionContext;
  private readonly driver: SdlSessionDriver;
  private readonly signalListeners = new Set<(signal: DataLinkSignal) => void>();

  /** @internal — constructed only by Ax25Listener. */
  constructor(driver: SdlSessionDriver) {
    this.driver = driver;
    this.context = driver.context;
  }

  /** Current SDL state name (e.g. "Disconnected", "Connected"). */
  get state(): string {
    return this.driver.currentState;
  }

  /** Drive one upper-layer / frame event through the SDL state machine. */
  postEvent(event: Ax25Event): void {
    this.driver.postEvent(event);
  }

  /** Subscribe to upward signals from the SDL action chain. */
  onDataLinkSignal(callback: (signal: DataLinkSignal) => void): void {
    this.signalListeners.add(callback);
  }

  /** Unsubscribe a previously-registered signal listener. */
  offDataLinkSignal(callback: (signal: DataLinkSignal) => void): void {
    this.signalListeners.delete(callback);
  }

  /** @internal — called by the listener's dispatcher shim. */
  _raiseDataLinkSignal(signal: DataLinkSignal): void {
    for (const cb of this.signalListeners) {
      try {
        cb(signal);
      } catch (err) {
        // Per-handler exception isolation: a buggy subscriber must not
        // suppress siblings. We swallow silently here — listeners that
        // want to observe handler exceptions wire onHandlerError on
        // the listener.
        void err;
      }
    }
  }

  /** @internal — used by the listener to force-disconnect on shutdown. */
  _setState(state: string): void {
    this.driver.setState(state);
  }

  // ─── Friendly facade — parity with Ax25Session ────────────────────
  //
  // The listener-owned session machine is a peer of `Ax25Session` (the
  // outbound-only facade owned by Ax25Stack). For consumers that just
  // want the high-level shape — "give me a callback for incoming
  // bytes, let me write outgoing bytes, tell me when the link drops" —
  // the methods below mirror `Ax25Session`'s public surface byte-for-
  // byte so a session from either source is drop-in compatible.
  //
  // The raw `postEvent` / `onDataLinkSignal` API above stays available
  // for consumers that need direct SDL-layer access (FRMR generation,
  // XID negotiation, custom error-recovery flows, …).

  /** The peer callsign — convenience accessor for `context.remote`. */
  get to(): Callsign {
    return this.context.remote;
  }

  /**
   * Register a callback invoked when the peer delivers I-frame (or
   * UI-frame, post-{@link DL_UNIT_DATA_indication}) info. Same shape as
   * {@link Ax25Session.onData}.
   */
  onData(callback: (chunk: Uint8Array) => void): void {
    this.onDataLinkSignal((sig) => {
      if (sig.type === "DL_DATA_indication" || sig.type === "DL_UNIT_DATA_indication") {
        callback(sig.data);
      }
    });
  }

  /**
   * Register a callback invoked when the session enters Disconnected
   * (either peer-initiated DISC or local DL_DISCONNECT_request that's
   * been confirmed). Same shape as {@link Ax25Session.onDisconnected}.
   */
  onDisconnected(callback: () => void): void {
    this.onDataLinkSignal((sig) => {
      if (sig.type === "DL_DISCONNECT_indication" || sig.type === "DL_DISCONNECT_confirm") {
        callback();
      }
    });
  }

  /**
   * Queue a payload for transmission as an I-frame. Resolves once the
   * bytes are accepted into the local TX queue (not once the peer has
   * ack'd). Throws if the session is not Connected. Mirrors
   * {@link Ax25Session.write}. Default PID is `0xF0` (no-layer-3).
   */
  async write(chunk: Uint8Array, pid: number = 0xf0): Promise<void> {
    if (this.state !== "Connected") {
      throw new Error(`cannot write in state ${this.state}`);
    }
    if (chunk.length === 0) return;
    this.postEvent({ name: "DL_DATA_request", data: chunk, pid });
  }

  /**
   * Initiate disconnect. Resolves on the next DL_DISCONNECT_confirm or
   * DL_DISCONNECT_indication. If the session is already Disconnected,
   * resolves immediately. Mirrors {@link Ax25Session.disconnect}.
   */
  async disconnect(): Promise<void> {
    if (this.state === "Disconnected") return;
    return new Promise<void>((resolve) => {
      const cb = (sig: DataLinkSignal): void => {
        if (sig.type === "DL_DISCONNECT_confirm" || sig.type === "DL_DISCONNECT_indication") {
          this.offDataLinkSignal(cb);
          resolve();
        }
      };
      this.onDataLinkSignal(cb);
      this.postEvent({ name: "DL_DISCONNECT_request" });
    });
  }
}

interface CachedSession {
  readonly session: Ax25ListenerSession;
  readonly driver: SdlSessionDriver;
  readonly scheduler: TimerScheduler;
  /** Queue of DL signals seen by this cached session, for ConnectAsync to await. */
  readonly signals: DataLinkSignal[];
  /**
   * The session's management data-link (MDL) driver — runs the XID
   * parameter-negotiation FSM. Started by the data-link's MDL-NEGOTIATE Request
   * poke (raised after the UA on a v2.2 connect); inbound XID-response /
   * FRMR-of-XID frames are routed here while it is negotiating. Negotiated
   * parameters land back on the session's context. Mirrors the C# listener's
   * `CachedSession.Mdl`.
   */
  readonly mdl: Ax25ManagementDataLink;
  /**
   * The session's §6.6 segmentation-reassembly shim. Sits at the DL primitive
   * boundary: the send helper ({@link Ax25Listener.sendData}) runs an over-N1
   * payload through its segmenter, and the `emitUpward` fan-out runs every
   * inbound DL-DATA indication through its reassembler (0x08 PID → reassemble,
   * else pass through). One per session — it owns the per-session reassembly
   * buffer. Mirrors the C# listener's `CachedSession.Segmentation`.
   */
  readonly segmentation: SegmentationLayer;
}

/**
 * First-class AX.25 inbound-acceptance coordinator. Owns one
 * {@link Ax25Transport}, address-filters inbound frames against
 * {@link Ax25Listener.myCall}, dispatches to the per-peer {@link Ax25ListenerSession}
 * (creating one on first contact — inbound SABM or outbound
 * {@link Ax25Listener.connect}), and surfaces per-frame TX/RX events so
 * monitor / promiscuous-capture UIs can tap the channel.
 *
 * Sibling to {@link Ax25Stack} — `Ax25Stack` is the outbound-only
 * convenience facade existing consumers use; `Ax25Listener` is the
 * inbound-accepting node-shape for BBSes, gateways, and the like.
 *
 * Mirrors `Packet.Ax25.Session.Ax25Listener` from the C# runtime; the
 * three carried-over bug fixes (handler-exception isolation, via-chain
 * reversal, cache-miss DM) are applied here too — see the PR description
 * for the cross-references.
 */
export class Ax25Listener {
  readonly myCall: Callsign;
  private readonly transport: Ax25Transport;
  private readonly options: Required<
    Omit<Ax25ListenerOptions, "myCall" | "configureSession" | "onHandlerError" | "quirks">
  > & {
    configureSession?: (session: Ax25ListenerSession) => void;
    onHandlerError: (err: unknown) => void;
    quirks?: Ax25SessionQuirks;
    preferExtendedConnect: boolean;
    preConnectXidNegotiatesSrej: boolean;
  };
  /** Per-peer cache keyed by the peer's canonical callsign string. */
  private readonly sessions = new Map<string, CachedSession>();
  /** LRU touch-order: oldest at the front, most-recent at the back. */
  private readonly lruOrder: string[] = [];

  private sessionAcceptedListeners = new Set<(session: Ax25ListenerSession) => void>();
  private frameTracedListeners = new Set<(e: Ax25FrameTracedEvent) => void>();

  private startedFlag = false;
  private disposed = false;
  private acceptIncomingFlag = true;

  constructor(transport: Ax25Transport, options: Ax25ListenerOptions) {
    this.transport = transport;
    this.myCall =
      typeof options.myCall === "string"
        ? Callsign.parse(options.myCall)
        : options.myCall;
    this.options = {
      t1Ms: options.t1Ms ?? 6000,
      t2Ms: options.t2Ms ?? 1500,
      t3Ms: options.t3Ms ?? 30000,
      n2: options.n2 ?? 10,
      k: options.k ?? 4,
      maxCachedPeers: options.maxCachedPeers ?? 64,
      parseOptions: options.parseOptions ?? LENIENT_PARSE,
      quirks: options.quirks,
      preferExtendedConnect: options.preferExtendedConnect ?? true,
      preConnectXidNegotiatesSrej: options.preConnectXidNegotiatesSrej ?? true,
      configureSession: options.configureSession,
      onHandlerError:
        options.onHandlerError ??
        ((err) => {
          // eslint-disable-next-line no-console
          console.error("Ax25Listener handler error:", err);
        }),
    };
  }

  /** True once {@link start} has been called and the inbound pump is running. */
  get isRunning(): boolean {
    return this.startedFlag && !this.disposed;
  }

  /**
   * Whether the listener will build a session for inbound SABMs. Flip to
   * `false` to reject all new incoming (figc4.1 t15 → DM); existing
   * sessions keep running. Default `true`.
   */
  get acceptIncoming(): boolean {
    return this.acceptIncomingFlag;
  }
  set acceptIncoming(value: boolean) {
    this.acceptIncomingFlag = value;
  }

  /** Register a callback for new (or re-confirmed) sessions. */
  onSessionAccepted(callback: (session: Ax25ListenerSession) => void): void {
    this.sessionAcceptedListeners.add(callback);
  }
  /** Unregister a previously-registered session-accepted callback. */
  offSessionAccepted(callback: (session: Ax25ListenerSession) => void): void {
    this.sessionAcceptedListeners.delete(callback);
  }

  /** Register a callback for every TX/RX frame the listener observes. */
  onFrameTraced(callback: (event: Ax25FrameTracedEvent) => void): void {
    this.frameTracedListeners.add(callback);
  }
  /** Unregister a previously-registered frame-traced callback. */
  offFrameTraced(callback: (event: Ax25FrameTracedEvent) => void): void {
    this.frameTracedListeners.delete(callback);
  }

  /**
   * Spin up the inbound pump. Returns once the transport's
   * `start` has resolved; the pump itself continues running in the
   * background until {@link stop}.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Ax25Listener has been disposed");
    if (this.startedFlag) return;
    await this.transport.start((bytes) => this.onInboundBytes(bytes));
    this.startedFlag = true;
  }

  /**
   * Initiate an outbound connect against this listener's
   * {@link myCall} + the given remote. Reuses the cached session for
   * that peer if one exists (preserves SRT / T1V history); otherwise
   * builds one. Resolves once DL-CONNECT-confirm arrives.
   *
   * Rejects with `Error` if the SDL responds with DM (peer refused)
   * or torn down before the connect completed; rejects with a timeout
   * error if N2 × T1V elapses with no UA.
   *
   * Whether this dial prefers AX.25 v2.2 (SABME / mod-128, degrading to v2.0 via
   * the FRMR (Spec45) and DM (Spec48) fallbacks) or initiates a plain v2.0
   * (SABM / mod-8) connect follows {@link Ax25ListenerOptions.preferExtendedConnect}
   * by default. Pass `extended` to override per dial: `true` prefers v2.2,
   * `false` forces a plain v2.0 connect. Mirrors C#'s
   * `ConnectAsync(remote, local, extended)`.
   *
   * @param remote The peer callsign.
   * @param extended Per-call override of the listener's `preferExtendedConnect`
   *   default. Omit to use the default.
   * @param preConnectXid Per-call override of the listener's
   *   `preConnectXidNegotiatesSrej` default. Only takes effect on a mod-8 dial
   *   (`extended === false`) — the v2.2/SABME path negotiates XID post-UA. The
   *   node's per-peer capability cache uses this to skip the pre-SABM XID probe
   *   for a neighbour it already knows does not answer one. Omit to use the
   *   default. Mirrors C# `ConnectAsync(remote, local, extended, preConnectXidNegotiatesSrej)`.
   */
  async connect(
    remote: Callsign | string,
    extended: boolean = this.options.preferExtendedConnect,
    preConnectXid: boolean = this.options.preConnectXidNegotiatesSrej,
  ): Promise<Ax25ListenerSession> {
    if (this.disposed) throw new Error("Ax25Listener has been disposed");
    if (!this.startedFlag) {
      throw new Error("listener has not been started; call start() first.");
    }
    const peer = typeof remote === "string" ? Callsign.parse(remote) : remote;
    const cached = this.getOrCreateSession(peer);
    this.touchLru(peer);

    // Drain any stale signals queued from a previous lifecycle on this
    // cached session so we don't fish out an old DL_CONNECT_confirm.
    cached.signals.length = 0;

    const ctx = cached.driver.context;

    // Choose the version this dial initiates BEFORE posting DL_CONNECT_request:
    // isExtended drives the Establish_Data_Link modulo branch (SABME vs SABM)
    // and, via ax25Spec44, routes the connect through AwaitingV22Connection
    // (figc4.6) so the FRMR/DM v2.0 fallbacks (Spec45 / Spec48) are reachable.
    // Set only on the outbound dial — the inbound answerer adopts the peer's
    // version from the SABM/SABME it receives (figc4.1). A cached session
    // re-dialled after a prior fallback dropped it to mod-8 is re-armed here, so
    // every dial starts from the caller's chosen preference. Mirrors C#'s
    // `cached.Session.Context.IsExtended = extended` in ConnectAsync.
    ctx.isExtended = extended;

    // LinBPQ SREJ accommodation (preConnectXidNegotiatesSrej): on a mod-8 dial,
    // run an XID command/response BEFORE the SABM to negotiate Selective Reject.
    // BPQ does mod-8 SREJ but only honours an XID that PRECEDES the SABM (its
    // ProcessXIDCommand runs on the no-active-link path and sets Ver2point2; an
    // XID on an established link is ignored). The v2.2 figures negotiate XID
    // post-UA instead — which never reaches BPQ's responder — so SREJ-to-BPQ
    // specifically needs this pre-SABM exchange. Safe regardless of peer: if no
    // XID response arrives in the budget, we fall through to a plain SABM
    // (go-back-N link). Skipped on the extended (SABME) path — that uses the
    // post-UA MDL negotiation. Mirrors C#'s NegotiateSrejBeforeConnectAsync.
    if (!extended && preConnectXid) {
      await this.negotiateSrejBeforeConnect(cached);
    }
    // Budget — (N2 + 1) × T1V matches the C# heuristic.
    const budgetMs = (ctx.n2 + 1) * ctx.t1vMs;
    const deadline = Date.now() + budgetMs;

    return new Promise<Ax25ListenerSession>((resolve, reject) => {
      const sigCb = (sig: DataLinkSignal): void => {
        switch (sig.type) {
          case "DL_CONNECT_confirm":
          case "DL_CONNECT_indication":
            cached.session.offDataLinkSignal(sigCb);
            this.raiseSessionAccepted(cached.session);
            resolve(cached.session);
            return;
          case "DL_DISCONNECT_indication":
          case "DL_DISCONNECT_confirm":
            cached.session.offDataLinkSignal(sigCb);
            reject(
              new Error(
                `outbound connect to ${peer.toString()} torn down before DL-CONNECT-confirm arrived (peer refused or link reset).`,
              ),
            );
            return;
        }
      };
      cached.session.onDataLinkSignal(sigCb);

      // Budget timer — fall back to TimeoutException semantics.
      const budgetTimer = setTimeout(() => {
        cached.session.offDataLinkSignal(sigCb);
        reject(
          new Error(
            `outbound connect to ${peer.toString()} timed out after ${(budgetMs / 1000).toFixed(1)}s without DL-CONNECT-confirm.`,
          ),
        );
      }, Math.max(0, deadline - Date.now()));

      // Wrap resolve/reject to clear the timer on early settle.
      const origResolve = resolve;
      const origReject = reject;
      resolve = (val) => {
        clearTimeout(budgetTimer);
        origResolve(val);
      };
      reject = (err) => {
        clearTimeout(budgetTimer);
        origReject(err);
      };

      // Drive the connect.
      cached.driver.postEvent({ name: "DL_CONNECT_request" });
    });
  }

  /**
   * Pre-SABM SREJ negotiation for the mod-8 dial (the LinBPQ accommodation gated
   * by {@link Ax25ListenerOptions.preConnectXidNegotiatesSrej}). Sets the context
   * SREJ-capable so the management-data-link's XID offer advertises SREJ +
   * SREJ-multiframe at mod-8, opens the negotiation, and waits a bounded time for
   * the peer's XID response (which the inbound router applies via the MDL, setting
   * `ctx.srejEnabled`) before returning so the caller can post DL_CONNECT_request.
   * A peer that does not answer XID leaves the MDL to exhaust its TM201 retries;
   * we cap the wait and proceed to a plain SABM (go-back-N) regardless — the dial
   * is never blocked by a non-XID peer. Mirrors the C#
   * `Ax25Listener.NegotiateSrejBeforeConnectAsync`.
   */
  private async negotiateSrejBeforeConnect(cached: CachedSession): Promise<void> {
    const ctx = cached.driver.context;

    // Offer SREJ: defaultOfferFor reads srejEnabled to advertise SREJ + the
    // OPSREJMult bit BPQ's XID responder requires. The peer's XID response is
    // applied by the inbound router (applyNegotiated), which sets srejEnabled to
    // the MUTUAL result — true only if the peer also offered SREJ.
    ctx.srejEnabled = true;
    ctx.implicitReject = false;

    // Track the negotiation outcome so a peer that never answers XID (TM201
    // give-up: MDL-ERROR, link context untouched) does not leave us wrongly
    // SREJ-enabled. A confirm means the peer's response was merged in (srejEnabled
    // now holds the true mutual value); anything else → force go-back-N.
    let confirmed = false;
    const onMdl = (sig: MdlSignal): void => {
      if (sig.type === "MDL_NEGOTIATE_confirm") confirmed = true;
    };
    cached.mdl.onMdlSignal(onMdl);

    cached.mdl.negotiate();

    // Optimistic short probe, NOT a full connection-retry budget. A peer that does
    // pre-session XID (BPQ) answers on the FIRST frame — its XID response is immediate
    // on the no-active-link path. A peer that doesn't (another PDN, a dumb v2.0 TNC)
    // never answers, so waiting the full (N2+1)·T1V establishment budget (≈ up to 12 s)
    // just stalls every mod-8 dial to it — including NET/ROM interlinks — before the
    // SABM fallback. So wait only ~2·T1V (one command + one retry / a loss margin),
    // floored at 1.5 s so a clean link gets a fair shot and capped at 3.5 s so a silent
    // peer degrades to go-back-N promptly. The MDL leaves Negotiating on the XID
    // response (success), a FRMR (v2.0 fallback), or give-up. (Adaptive per-neighbour
    // reuse is the capability cache — remember who answers and skip the probe.)
    const budgetMs = Math.min(3_500, Math.max(1_500, 2 * ctx.t1vMs));
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && cached.mdl.isNegotiating) {
      await delay(25);
    }

    // No confirmed XID negotiation (silent peer / give-up) → the peer can't do
    // SREJ; revert to go-back-N so we never put SREJ on the wire unilaterally.
    if (!confirmed) {
      ctx.srejEnabled = false;
      ctx.implicitReject = true;
    }
  }

  /**
   * Send an upper-layer (Layer-3) payload over an established session, applying
   * §6.6 segmentation at the DL boundary. This is the send-side counterpart to
   * the receive-side reassembly wired into every session's upward-signal
   * fan-out. Mirrors the C# `Ax25Listener.SendData`.
   *
   * If the session has negotiated the segmenter
   * ({@link Ax25SessionContext.segmenterReassemblerEnabled}) and the payload
   * exceeds N1, the payload is split into PID-0x08 I-frame segments and each is
   * posted as its own `DL_DATA_request`. Otherwise a single un-segmented request
   * is posted. An over-N1 payload on a session that has *not* negotiated the
   * segmenter throws — the request is rejected cleanly rather than truncated or
   * sent oversize.
   *
   * Callers that want to send a raw, never-segmented request (e.g. a frame they
   * have already segmented, or a control payload) can still post a
   * `DL_DATA_request` via {@link Ax25ListenerSession.postEvent} / `write`; this
   * helper is the segmentation-aware path.
   *
   * @param session A session previously returned by {@link connect} or the
   *   `sessionAccepted` event.
   * @param data The upper-layer payload.
   * @param pid The Layer-3 PID for the (un-segmented) request. Defaults to
   *   `0xF0` (no-layer-3).
   * @throws Error if `session` is not a session this listener owns.
   * @throws Error if the payload exceeds N1 and the segmenter has not been
   *   negotiated for this session.
   */
  sendData(
    session: Ax25ListenerSession,
    data: Uint8Array,
    pid: number = PID_NO_LAYER_3,
  ): void {
    if (this.disposed) throw new Error("Ax25Listener has been disposed");

    const cached = this.sessions.get(session.to.toString());
    if (!cached || cached.session !== session) {
      throw new Error(
        "the supplied session is not owned by this listener (it was not produced by connect() / " +
          "sessionAccepted, or has been evicted from the cache).",
      );
    }

    for (const request of cached.segmentation.buildSendRequests(data, pid)) {
      session.postEvent(request);
    }
  }

  /**
   * Send a connectionless UI (unproto) frame on this port's transport — the
   * send path connected-mode {@link sendData} is not: it bypasses the session
   * layer entirely. This is what an upper layer uses to transmit
   * promiscuously-heard broadcasts (NET/ROM NODES routing broadcasts ride a UI
   * frame: PID 0xCF, AX.25 destination the literal text callsign `NODES`).
   *
   * The source callsign is this listener's {@link myCall}; the frame is built
   * via the strict {@link ui} factory (the outbound construction path stays
   * spec-faithful, per CLAUDE.md) as a command (C-bit set), and traced as a
   * `tx` frame *after* the send so the monitor's TX order matches the wire
   * (mirroring the per-session `sendFrame` ordering).
   *
   * Resolves once the transport's `send` resolves (the bytes are accepted by
   * the transport, not once any peer has heard them — a UI frame is
   * unacknowledged). Mirrors the C# `Ax25Listener.SendUiAsync`.
   *
   * @param destination The UI frame's AX.25 destination (e.g. the literal
   *   `NODES` callsign for a NET/ROM routing broadcast).
   * @param info The UI frame's information field.
   * @param pid The Layer-3 PID. Defaults to `0xF0` (no-layer-3).
   * @throws Error if the listener has been disposed.
   */
  async sendUi(
    destination: Callsign,
    info: Uint8Array,
    pid: number = PID_NO_LAYER_3,
  ): Promise<void> {
    if (this.disposed) throw new Error("Ax25Listener has been disposed");
    const frame = ui({
      destination,
      source: this.myCall,
      info,
      pid,
      isCommand: true,
    });
    await this.transport.send(encodeFrame(frame));
    // Trace AFTER the send so the monitor's TX order matches the wire.
    try {
      this.traceFrame(frame, "tx");
    } catch (err) {
      this.options.onHandlerError(err);
    }
  }

  /**
   * Send a connectionless AX.25 **TEST command** frame (§4.3.4.2) — the
   * "axping" probe. A spec-compliant responder echoes the information field
   * back in a TEST *response*; the caller correlates that response (via
   * {@link onFrameTraced}) to measure round-trip time. Like {@link sendUi}
   * this bypasses the session layer entirely (no connection needed). Not
   * every node implements TEST — a peer that doesn't simply never responds
   * (the caller sees a timeout / loss), which is not an error. Mirrors the C#
   * `Ax25Listener.SendTestAsync` (packet.net#348).
   *
   * @param destination The station to probe.
   * @param info The probe's information field (echoed back verbatim).
   * @param pollFinalBit P bit; defaults `true` (a command soliciting a response).
   */
  async sendTest(
    destination: Callsign,
    info: Uint8Array,
    pollFinalBit = true,
  ): Promise<void> {
    if (this.disposed) throw new Error("Ax25Listener has been disposed");
    const frame = test({
      destination,
      source: this.myCall,
      info,
      isCommand: true,
      pollFinal: pollFinalBit,
    });
    await this.transport.send(encodeFrame(frame));
    try {
      this.traceFrame(frame, "tx");
    } catch (err) {
      this.options.onHandlerError(err);
    }
  }

  /** Stop the inbound pump and release the transport. */
  async stop(): Promise<void> {
    if (!this.startedFlag) return;
    this.startedFlag = false;
    try {
      await this.transport.stop();
    } catch (err) {
      this.options.onHandlerError(err);
    }
    // Cancel timers on every cached session so background timer
    // expiries don't fire after stop.
    for (const cached of this.sessions.values()) {
      cached.scheduler.cancel("T1");
      cached.scheduler.cancel("T2");
      cached.scheduler.cancel("T3");
    }
  }

  /** Dispose the listener: stop the pump + clear the per-peer cache. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
    this.sessions.clear();
    this.lruOrder.length = 0;
    this.sessionAcceptedListeners.clear();
    this.frameTracedListeners.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private onInboundBytes(bytes: Uint8Array): void {
    let frame: Ax25Frame;
    try {
      // Routing parse at mod-8 — we don't yet know which session (hence which
      // modulo). Addresses precede the control field and are modulo-
      // independent, so session lookup is always valid; an extended (mod-128)
      // I/S frame's 2-octet control field is re-decoded session-side in
      // dispatchInbound once the modulo is known. Parsed under the listener's
      // configured options: a frame they reject is dropped here — before
      // tracing and dispatch — so a strict listener is deaf to it end-to-end
      // (no session can open from it, and the monitor doesn't see it either).
      // Mirrors the C# listener's inbound pump (packet.net#366).
      frame = decodeFrame(bytes, false, this.options.parseOptions);
    } catch {
      return; // malformed / options-rejected wire bytes — drop quietly
    }
    // Trace + dispatch are isolated per-step so a throwing handler can't
    // tear the pump down. A buggy consumer must not be able to DoS the
    // modem. (#140 carry-over.)
    try {
      this.traceFrame(frame, "rx");
    } catch (err) {
      this.options.onHandlerError(err);
    }
    try {
      this.dispatchInbound(frame, bytes);
    } catch (err) {
      this.options.onHandlerError(err);
    }
  }

  private dispatchInbound(routed: Ax25Frame, bytes: Uint8Array): void {
    // Frames not addressed to us: monitor-only (trace already fired).
    if (!routed.destination.callsign.equals(this.myCall)) {
      return;
    }

    // Connectionless TEST (§4.3.4.2), addressed to us — handle it BEFORE any
    // session routing. TEST is link-independent: it must never enter the
    // session machine (where it would fall to the Disconnected t05 catch-all
    // and provoke a spurious DM, or disturb a live QSO's state).
    //
    //   • TEST *command*  → we are the responder: reply with a TEST response
    //     echoing the information field (the "axping" answer).
    //   • TEST *response* → the echo to our own probe. The initiator
    //     correlates it via frameTraced, which already fired upstream — so we
    //     simply absorb it here rather than provoke a DM at a station that
    //     just answered us.
    //
    // Either way we return without touching a session. Mirrors the C#
    // listener's TEST intercept (packet.net#348).
    if (classify(routed) === "TEST") {
      if (frameIsCommand(routed)) {
        this.respondToTest(routed);
      }
      return;
    }

    const peer = routed.source.callsign;
    const peerKey = peer.toString();

    const cached = this.sessions.get(peerKey);
    if (cached) {
      this.touchLru(peer);
      // The routing parse above was mod-8. Re-decode at the session's
      // negotiated modulo before classifying so an extended (mod-128) I/S
      // frame's N(S)/N(R)/PID/info land correctly (mirrors the C# listener's
      // ReparseAtSessionModulo).
      const parsed = reparseAtSessionModulo(
        routed,
        bytes,
        cached.session.context,
        this.options.parseOptions,
      );
      // Classify the frame into the SDL event the dispatcher should receive. A
      // spec-violating frame (info on an S / no-info U frame; unknown U control
      // byte) maps to the matching error event here — so the figc4.x error-input
      // transition (DL-ERROR + re-establish) fires instead of the frame being
      // silently processed. Mirrors C#'s `Ax25FrameClassifier.Classify`.
      const event = classifyFrame(parsed);

      // XID / FRMR-of-XID routing — these belong to the MDL machine, not the
      // data-link session (the data-link Connected state has no XID handler,
      // and would FRMR-handle a FRMR as a full link reset):
      //
      //   • XID *command*            → we are the responder: build + send the
      //     XID response (the un-transcribed figc5.1 responder path).
      //   • XID *response* while negotiating → we are the initiator: figc5.2
      //     applies the negotiated parameters.
      //   • FRMR while negotiating   → figc5.2 §6.3.2 ¶1 v2.0 fallback.
      //
      // Outside those, frames fall through to the data-link session unchanged
      // (e.g. a stray XID response with no negotiation → the data-link
      // catch-all; a real FRMR on an established link → data-link FRMR
      // handling). C/R-bit disambiguated. Mirrors C#'s DispatchInbound routing.
      if (event.name === "XID_received" && frameIsCommand(parsed)) {
        cached.mdl.respondToXidCommand(parsed);
        return;
      }
      if (cached.mdl.isNegotiating && event.name === "XID_received") {
        cached.mdl.onXidReceived(parsed);
        return;
      }
      if (cached.mdl.isNegotiating && event.name === "FRMR_received") {
        cached.mdl.onFrmrReceived(parsed);
        return;
      }

      const stateBefore: string = cached.session.state;
      const wasDisconnected = stateBefore === "Disconnected";
      const isReconnectSabm =
        wasDisconnected &&
        (event.name === "SABM_received" || event.name === "SABME_received");
      cached.session.postEvent(event);
      const stateAfter: string = cached.session.state;
      if (isReconnectSabm && stateAfter === "Connected") {
        this.raiseSessionAccepted(cached.session);
      }
      return;
    }

    // No cached session — the establishment / transient paths below deal in
    // U-frames (SABM/SABME) or fall to the Disconnected catch-all (→ DM), all
    // correctly decoded at mod-8: an unknown peer can't already have an
    // extended link with us, so no second pass is needed here.
    const parsed = routed;
    // Classify into the SDL event (spec-violating frames → the matching error
    // event; see the cached-session branch above). Mirrors C#'s
    // `Ax25FrameClassifier.Classify` on the cache-miss path.
    const event = classifyFrame(parsed);

    // Pre-session XID *command* (a peer negotiating before it sends SABM —
    // e.g. a PDN↔PDN NET/ROM mod-8 interlink, or BPQ's pre-connect XID). This
    // is plain spec-compliant MDL behaviour: §4.3.3.7 — "a station receiving an
    // XID command returns an XID response" — is unconditional (no active link
    // required), §6.3.2 has the negotiation precede the connection, and Annex
    // C5.3 models the MDL as a connection-independent machine. So we answer it
    // unconditionally (no named flag / quirk / option — answering is mandatory,
    // not opt-in) — but only when we'd accept the connection it precedes (gate
    // on acceptIncoming, exactly like the SABM-accept path below; if we won't
    // accept the link we shouldn't half-open from its XID).
    //
    // We build a real session and cache it keyed by the peer: object identity
    // persists the negotiated link context across the XID→SABM sequence (both
    // are keyed the same), so the subsequent inbound SABM's figc4.1 t14 "Set
    // Version 2.0" — which clears only IsExtended, never SrejEnabled — adopts the
    // XID-negotiated SREJ. We seed SrejEnabled=true / ImplicitReject=false so the
    // MDL's DefaultOfferFor advertises SREJ; respondToXidCommand's §6.3.2 merge
    // then reverts it to the mutual result (false if the peer didn't offer SREJ).
    //
    // No SessionAccepted is raised (there's no DL-CONNECT yet — the SABM raises
    // it), and the scheduler is NOT cancelled/disposed (unlike the transient
    // fall-through): the session must persist for the SABM, and the XID responder
    // arms no timer, so nothing leaks. Mirrors the cached-session XID-command
    // responder path above.
    if (event.name === "XID_received" && frameIsCommand(parsed) && this.acceptIncoming) {
      const built = this.buildSession(peer, true);
      this.addToCache(peer, built);
      this.options.configureSession?.(built.session);
      built.session.context.srejEnabled = true;
      built.session.context.implicitReject = false;
      built.mdl.respondToXidCommand(parsed);
      return;
    }

    // Cache miss path. See C# DispatchInbound for the rationale block;
    // mirrored here.
    const isSabmShaped =
      event.name === "SABM_received" || event.name === "SABME_received";

    if (isSabmShaped && this.acceptIncoming) {
      // Accept path: build the session, cache it, fire consumer hook
      // before posting SABM so consumers can attach listeners on the
      // session's signal stream before any events flow.
      const built = this.buildSession(peer, true);
      this.addToCache(peer, built);
      this.options.configureSession?.(built.session);
      built.session.postEvent(event);
      this.raiseSessionAccepted(built.session);
      return;
    }

    // Transient fall-through:
    //   SABM-shape with acceptIncoming=false → figc4.1 t15 emits DM.
    //   DISC/UI/UA unknown peer            → specific Disconnected transition.
    //   RR/RNR/REJ/SREJ/I/FRMR/XID         → reclassify as all_other_commands
    //                                          so t05 fires DM.
    // Build, post, drop. No cache write, no SessionAccepted event.
    // (#143 carry-over.)
    const transient = this.buildSession(peer, this.acceptIncoming);
    const transientEvent = isSabmShaped
      ? event
      : reclassifyForDisconnectedCatchAll(event, parsed);
    transient.session.postEvent(transientEvent);
    // Cancel any timers the SDL armed.
    transient.scheduler.cancel("T1");
    transient.scheduler.cancel("T2");
    transient.scheduler.cancel("T3");
  }

  private getOrCreateSession(peer: Callsign): CachedSession {
    const key = peer.toString();
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const built = this.buildSession(peer, true);
    this.addToCache(peer, built);
    this.options.configureSession?.(built.session);
    return built;
  }

  /**
   * Answer an inbound connectionless TEST *command* (§4.3.4.2) with a TEST
   * *response* echoing the command's information field verbatim. The
   * response's F bit mirrors the command's P bit; the source is this
   * station's call. Fire-and-forget — a failed send (transport torn down
   * mid-flight) must not tear the inbound pump down. Mirrors the C#
   * listener's `RespondToTest` (packet.net#348).
   */
  private respondToTest(command: Ax25Frame): void {
    const frame = test({
      destination: command.source.callsign,
      source: this.myCall,
      // Copy the echoed info: the pump may reuse the inbound buffer.
      info: command.info.slice(),
      isCommand: false,
      pollFinal: framePollFinal(command),
    });
    void this.transport
      .send(encodeFrame(frame))
      .then(() => {
        // Trace AFTER the send so the monitor's TX order matches the wire.
        try {
          this.traceFrame(frame, "tx");
        } catch (err) {
          this.options.onHandlerError(err);
        }
      })
      .catch((err) => this.options.onHandlerError(err));
  }

  private buildSession(peer: Callsign, allowAccept: boolean): CachedSession {
    const ctx = createSessionContext(this.myCall, peer);
    ctx.acceptIncoming = allowAccept;
    // Seed the listener's configured session quirks before any SDL transition
    // runs (createSessionContext starts from the spec-correct defaults).
    // Mirrors the C# listener's BuildSession quirks seed (packet.net#366).
    if (this.options.quirks) ctx.quirks = { ...this.options.quirks };
    ctx.n2 = this.options.n2;
    ctx.k = this.options.k;
    if (this.options.t1Ms !== undefined) ctx.t1vMs = this.options.t1Ms;
    if (this.options.t2Ms !== undefined) ctx.t2Ms = this.options.t2Ms;

    const scheduler = new RealTimerScheduler();
    const signals: DataLinkSignal[] = [];
    const segmentation = new SegmentationLayer(ctx);

    let sessionRef: Ax25ListenerSession | null = null;

    const sendFrame = (frame: Ax25Frame): void => {
      // Fire-and-forget — the dispatcher's frame sinks are sync.
      const bytes = encodeFrame(frame);
      void this.transport.send(bytes);
      try {
        this.traceFrame(frame, "tx");
      } catch (err) {
        this.options.onHandlerError(err);
      }
    };

    // Receive-side segmentation seam (§2.4 / §6.6): every DL-DATA indication
    // passes through the reassembler first. A 0x08-PID segment is consumed and
    // only delivered when the series completes (the shim returns null until the
    // last segment); a non-segment indication passes through unchanged. Non-DATA
    // signals (connect/disconnect/error) bypass the shim entirely. The
    // dispatcher's `DL_DATA_indication => emitUpward(...)` is untouched — the
    // seam is here at the boundary, keeping the dispatcher / SDL clean. Mirrors
    // the C# listener's `SendUpward`.
    const emitUpward = (sig: DataLinkSignal): void => {
      if (sig.type === "DL_DATA_indication") {
        const reassembled = segmentation.onDataIndication(sig);
        if (reassembled === null) return; // mid-series segment — nothing to deliver yet
        sig = reassembled;
      }
      signals.push(sig);
      sessionRef?._raiseDataLinkSignal(sig);
    };

    // The session's MDL driver shares the session's scheduler (TM201 is a
    // distinct timer name, so it doesn't collide with T1/T2/T3) and the same
    // wire sink. Built before the data-link driver so the data-link's
    // MDL-NEGOTIATE Request poke (raised by figc4.6 after the UA on a v2.2
    // connect) can route straight into it. Negotiated parameters mutate this
    // session's context (ctx) — the same context the data-link runs on. Mirrors
    // the C# listener's `new Ax25ManagementDataLink(ctx, scheduler, SendBytes)`.
    const mdl = new Ax25ManagementDataLink(ctx, scheduler, sendFrame);

    const driver = new SdlSessionDriver(
      ctx,
      scheduler,
      {
        sendFrame,
        emitUpward,
        // Per SDL semantics: unmatched events are silently ignored.
        onUnhandledEvent: () => {
          /* no-op */
        },
        t1Ms: this.options.t1Ms,
        t2Ms: this.options.t2Ms,
        t3Ms: this.options.t3Ms,
        // Honour caller-supplied t1Ms statically (matches the existing
        // Ax25Stack/Ax25Session behaviour — TS port stubs Select_T1_Value
        // so we mustn't let the SDL's `T1V := 2 * SRT` overwrite the
        // initial value the caller asked for).
        freezeT1V: this.options.t1Ms !== undefined,
        // The figc4.6 UA-received path raises MDL-NEGOTIATE Request after a
        // successful v2.2 connect; hand it to the MDL driver to open the XID
        // exchange. Mirrors C#'s sendInternal routing to mdl.Negotiate().
        mdl: { onMdlNegotiateRequest: () => mdl.negotiate() },
      },
      "Disconnected",
    );

    const session = new Ax25ListenerSession(driver);
    sessionRef = session;
    return { session, driver, scheduler, signals, mdl, segmentation };
  }

  private addToCache(peer: Callsign, built: CachedSession): void {
    const key = peer.toString();
    this.sessions.set(key, built);
    this.updateLru(key);
    this.evictExcess();
  }

  private touchLru(peer: Callsign): void {
    this.updateLru(peer.toString());
  }

  private updateLru(key: string): void {
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
    this.lruOrder.push(key);
  }

  private evictExcess(): void {
    while (this.lruOrder.length > this.options.maxCachedPeers) {
      const evicted = this.lruOrder.shift();
      if (evicted === undefined) break;
      const cached = this.sessions.get(evicted);
      if (cached) {
        cached.scheduler.cancel("T1");
        cached.scheduler.cancel("T2");
        cached.scheduler.cancel("T3");
      }
      this.sessions.delete(evicted);
    }
  }

  private raiseSessionAccepted(session: Ax25ListenerSession): void {
    // (#140 carry-over) Per-handler exception isolation — wrap each
    // invocation so a throwing subscriber can't stop the others firing
    // or DoS the pump.
    for (const cb of this.sessionAcceptedListeners) {
      try {
        cb(session);
      } catch (err) {
        this.options.onHandlerError(err);
      }
    }
  }

  private traceFrame(frame: Ax25Frame, direction: FrameDirection): void {
    if (this.frameTracedListeners.size === 0) return;
    const e: Ax25FrameTracedEvent = {
      frame,
      direction,
      timestamp: new Date(),
    };
    for (const cb of this.frameTracedListeners) {
      try {
        cb(e);
      } catch (err) {
        this.options.onHandlerError(err);
      }
    }
  }
}

/** Resolve after `ms` milliseconds — the bounded-wait primitive the pre-connect
 * XID negotiation polls on (mirrors the C# `Task.Delay` budget loop). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-decode an inbound I/S frame at a known session's negotiated modulo. The
 * inbound pump parses every frame at mod-8 for routing (the session, and thus
 * the modulo, isn't known until the address is read) — which is always valid
 * for the address fields but mis-reads an extended (mod-128) I/S frame's
 * 2-octet control field. Once the session is matched, this second pass
 * re-parses the raw bytes at the session's modulo. Returns `routed` unchanged
 * for mod-8 links and for U frames (1 octet in both modes); re-parses only an
 * extended link's I/S frames, falling back to `routed` if the second parse
 * somehow fails (it can't, given the first succeeded). Mirrors the C#
 * `Ax25Listener.ReparseAtSessionModulo`.
 */
function reparseAtSessionModulo(
  routed: Ax25Frame,
  bytes: Uint8Array,
  ctx: Ax25SessionContext,
  parseOptions: Ax25ParseOptions,
): Ax25Frame {
  if (!ctx.isExtended) return routed; // mod-8 link: the routing parse was correct
  if (routed.controlExtension !== null) return routed; // already 2-octet (defensive)
  const isUFrame = (routed.control & 0x03) === 0x03; // U frames are 1 octet in both modes
  if (isUFrame) return routed;
  try {
    // Same options as the routing parse — a frame can't get stricter or
    // looser treatment just because its session negotiated mod-128.
    return decodeFrame(bytes, true, parseOptions);
  } catch {
    return routed;
  }
}

/**
 * Map an inbound classified event to the event the Disconnected SDL knows
 * how to handle. Specific events handled in Disconnected (DISC/UI/UA/SABM/SABME)
 * pass through unchanged; everything else (RR/RNR/REJ/SREJ/I/FRMR/XID, plus
 * the spec-violation error events) becomes `all_other_commands` so the SDL's t05
 * catch-all emits DM. See figc4.1 — the catch-all is named "all other commands"
 * precisely for this case. Mirrors the C# `ReclassifyForDisconnectedCatchAll`
 * helper, which switches on the classified event type (#143 carry-over).
 */
function reclassifyForDisconnectedCatchAll(
  event: Ax25Event,
  frame: Ax25Frame,
): Ax25Event {
  switch (event.name) {
    case "SABM_received":
    case "SABME_received":
    case "DISC_received":
    case "UI_received":
    case "UA_received":
      return event;
    default:
      return { name: "all_other_commands", frame };
  }
}
