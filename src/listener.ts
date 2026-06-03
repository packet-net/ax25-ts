import { Callsign } from "./callsign.js";
import {
  type Ax25Frame,
  classify,
  decodeFrame,
  encodeFrame,
  isCommand as frameIsCommand,
} from "./frame.js";
import type { DataLinkSignal } from "./sdl/action-dispatcher.js";
import type { Ax25Event } from "./sdl/events.js";
import { Ax25ManagementDataLink } from "./sdl/management-data-link.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "./sdl/session-context.js";
import { SdlSessionDriver } from "./sdl/session-driver.js";
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
    Omit<Ax25ListenerOptions, "myCall" | "configureSession" | "onHandlerError">
  > & {
    configureSession?: (session: Ax25ListenerSession) => void;
    onHandlerError: (err: unknown) => void;
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
   */
  async connect(remote: Callsign | string): Promise<Ax25ListenerSession> {
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
      // dispatchInbound once the modulo is known.
      frame = decodeFrame(bytes);
    } catch {
      return; // malformed wire bytes — drop quietly
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
    const peer = routed.source.callsign;
    const peerKey = peer.toString();

    const cached = this.sessions.get(peerKey);
    if (cached) {
      this.touchLru(peer);
      // The routing parse above was mod-8. Re-decode at the session's
      // negotiated modulo before classifying so an extended (mod-128) I/S
      // frame's N(S)/N(R)/PID/info land correctly (mirrors the C# listener's
      // ReparseAtSessionModulo).
      const parsed = reparseAtSessionModulo(routed, bytes, cached.session.context);
      const kind = classify(parsed);

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
      if (kind === "XID" && frameIsCommand(parsed)) {
        cached.mdl.respondToXidCommand(parsed);
        return;
      }
      if (cached.mdl.isNegotiating && kind === "XID") {
        cached.mdl.onXidReceived(parsed);
        return;
      }
      if (cached.mdl.isNegotiating && kind === "FRMR") {
        cached.mdl.onFrmrReceived(parsed);
        return;
      }

      const event = mapKindToEvent(parsed, kind);
      if (event === null) return; // unknown — drop
      const stateBefore: string = cached.session.state;
      const wasDisconnected = stateBefore === "Disconnected";
      const isReconnectSabm =
        wasDisconnected && (kind === "SABM" || kind === "SABME");
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
    const kind = classify(parsed);
    const event = mapKindToEvent(parsed, kind);
    if (event === null) return; // unknown — drop

    // Cache miss path. See C# DispatchInbound for the rationale block;
    // mirrored here.
    const isSabmShaped = kind === "SABM" || kind === "SABME";

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
    //   RR/RNR/REJ/SREJ/I/FRMR/XID/TEST    → reclassify as all_other_commands
    //                                          so t05 fires DM.
    // Build, post, drop. No cache write, no SessionAccepted event.
    // (#143 carry-over.)
    const transient = this.buildSession(peer, this.acceptIncoming);
    const transientEvent = isSabmShaped
      ? event
      : reclassifyForDisconnectedCatchAll(kind, event, parsed);
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

  private buildSession(peer: Callsign, allowAccept: boolean): CachedSession {
    const ctx = createSessionContext(this.myCall, peer);
    ctx.acceptIncoming = allowAccept;
    ctx.n2 = this.options.n2;
    ctx.k = this.options.k;
    if (this.options.t1Ms !== undefined) ctx.t1vMs = this.options.t1Ms;
    if (this.options.t2Ms !== undefined) ctx.t2Ms = this.options.t2Ms;

    const scheduler = new RealTimerScheduler();
    const signals: DataLinkSignal[] = [];

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

    const emitUpward = (sig: DataLinkSignal): void => {
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
    return { session, driver, scheduler, signals, mdl };
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
): Ax25Frame {
  if (!ctx.isExtended) return routed; // mod-8 link: the routing parse was correct
  if (routed.controlExtension !== null) return routed; // already 2-octet (defensive)
  const isUFrame = (routed.control & 0x03) === 0x03; // U frames are 1 octet in both modes
  if (isUFrame) return routed;
  try {
    return decodeFrame(bytes, true);
  } catch {
    return routed;
  }
}

/**
 * Map a wire-frame {@link FrameKind} to the matching SDL event. Returns
 * null for frames the SDL doesn't model. The returned event carries the
 * triggering frame so frame-aware guard predicates can read fields from
 * it (`P_eq_1`, `command`, `N_s_eq_V_r`, …).
 */
function mapKindToEvent(frame: Ax25Frame, kind: string): Ax25Event | null {
  switch (kind) {
    case "SABM":
      return { name: "SABM_received", frame };
    case "SABME":
      return { name: "SABME_received", frame };
    case "DISC":
      return { name: "DISC_received", frame };
    case "UA":
      return { name: "UA_received", frame };
    case "DM":
      return { name: "DM_received", frame };
    case "UI":
      return { name: "UI_received", frame };
    case "RR":
      return { name: "RR_received", frame };
    case "RNR":
      return { name: "RNR_received", frame };
    case "REJ":
      return { name: "REJ_received", frame };
    case "I":
      return { name: "I_received", frame };
    default:
      return null;
  }
}

/**
 * Map an inbound classified event to the event the Disconnected SDL knows
 * how to handle. Specific events handled in Disconnected (DISC/UI/UA/SABM/SABME)
 * pass through unchanged; everything else (RR/RNR/REJ/SREJ/I/FRMR/XID/TEST)
 * becomes `all_other_commands` so the SDL's t05 catch-all emits DM. See
 * figc4.1 — the catch-all is named "all other commands" precisely for
 * this case. Mirrors the C# `ReclassifyForDisconnectedCatchAll` helper
 * (#143 carry-over).
 */
function reclassifyForDisconnectedCatchAll(
  kind: string,
  event: Ax25Event,
  frame: Ax25Frame,
): Ax25Event {
  switch (kind) {
    case "SABM":
    case "SABME":
    case "DISC":
    case "UI":
    case "UA":
      return event;
    default:
      return { name: "all_other_commands", frame };
  }
}
