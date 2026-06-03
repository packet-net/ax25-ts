import { Callsign } from "./callsign.js";
import {
  type Ax25Frame,
  decodeFrame,
  encodeFrame,
} from "./frame.js";
import type { DataLinkSignal } from "./sdl/action-dispatcher.js";
import { classifyFrame } from "./sdl/frame-classifier.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "./sdl/session-context.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
} from "./sdl/session-quirks.js";
import { SdlSessionDriver } from "./sdl/session-driver.js";
import { RealTimerScheduler } from "./sdl/timer-scheduler.js";
import type { Ax25Transport } from "./transport.js";

/**
 * Table-driven AX.25 v2.2 connected-mode session.
 *
 * Internally walks the generated SDL transition tables in
 * [`ax25sdl`](../../../ts-spec/) — same encoding as the C# runtime's
 * `Packet.Ax25.Sdl.*` tables. For each posted event the driver looks up
 * transitions for the current state, evaluates guards, picks the first
 * match, runs the action chain, and advances to `next`.
 *
 * Public API is unchanged from the previous hand-rolled implementation:
 * `connect`, `onData`, `onDisconnected`, `write`, `disconnect`.
 */
const DEFAULT_T1_MS = 3000;
const DEFAULT_N2 = 10;
const DEFAULT_PID = 0xf0;

export interface Ax25SessionOptions {
  /** T1 retry timeout (ms). Default 3000. */
  t1Ms?: number;
  /** T2 response-delay timeout (ms). Default 1500. */
  t2Ms?: number;
  /** T3 inactive-link timeout (ms). Default 30000. */
  t3Ms?: number;
  /** Maximum retries (N2). Default 10. */
  n2?: number;
  /** PID for outbound I-frames. Default 0xF0 (no L3 protocol). */
  pid?: number;
  /**
   * Per-session deviations from the SDL figures where a figure is a
   * confirmed upstream spec defect (see {@link Ax25SessionQuirks}).
   * Defaults to the spec-correct preset; pass
   * {@link strictlyFaithfulSessionQuirks} to run the figures exactly
   * as drawn for conformance testing.
   */
  quirks?: Ax25SessionQuirks;
}

/**
 * One connected-mode AX.25 session. Created via {@link Ax25Stack.connect}.
 * Callers register data/disconnect listeners, push outbound bytes via
 * {@link Ax25Session.write}, and tear down the link via
 * {@link Ax25Session.disconnect}.
 */
export class Ax25Session {
  readonly from: Callsign;
  readonly to: Callsign;
  private readonly send: (frame: Ax25Frame) => Promise<void>;
  private readonly removeFromStack: () => void;
  private readonly opts: Required<Ax25SessionOptions>;
  private readonly driver: SdlSessionDriver;
  private readonly sessionContext: Ax25SessionContext;

  /** Resolves when SABM exchange completes; rejects on N2 exhaustion / DM. */
  private connectResolver: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  /** Resolves when DISC exchange completes. */
  private disconnectResolver: { resolve: () => void } | null = null;

  private dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  /** Tracks whether the driver has ever left Disconnected (for disconnect()). */
  private hasBeenConnected = false;
  /**
   * Sticky pending error captured from a DL-ERROR indication during the
   * pending action chain — surfaced on the next DL_DISCONNECT_indication
   * so the connect promise rejects with the spec error letter. AX.25
   * DL-ERROR(G) = "Connection timed out (retry limit reached)".
   */
  private pendingError: string | null = null;

  /** @internal — constructed only by Ax25Stack. */
  constructor(
    from: Callsign,
    to: Callsign,
    send: (frame: Ax25Frame) => Promise<void>,
    removeFromStack: () => void,
    opts: Ax25SessionOptions = {},
  ) {
    this.from = from;
    this.to = to;
    this.send = send;
    this.removeFromStack = removeFromStack;
    this.opts = {
      t1Ms: opts.t1Ms ?? DEFAULT_T1_MS,
      t2Ms: opts.t2Ms ?? 1500,
      t3Ms: opts.t3Ms ?? 30000,
      n2: opts.n2 ?? DEFAULT_N2,
      pid: opts.pid ?? DEFAULT_PID,
      quirks: opts.quirks ?? defaultSessionQuirks,
    };

    this.sessionContext = createSessionContext(from, to);
    if (opts.quirks) {
      this.sessionContext.quirks = { ...opts.quirks };
    }
    this.sessionContext.n2 = this.opts.n2;
    this.sessionContext.t1vMs = this.opts.t1Ms;
    // k=1 is a documented v1 reduction: only one outstanding I-frame
    // at a time. The SDL guard `V_s_eq_V_a_plus_k` uses ctx.k, so this
    // sets the dispatcher's window size.
    this.sessionContext.k = 1;

    const scheduler = new RealTimerScheduler();
    this.driver = new SdlSessionDriver(this.sessionContext, scheduler, {
      sendFrame: (frame) => {
        void this.send(frame);
      },
      emitUpward: (signal) => this.handleUpwardSignal(signal),
      onUnhandledEvent: () => {
        // Per SDL semantics: unmatched events are silently ignored.
      },
      t1Ms: this.opts.t1Ms,
      t2Ms: this.opts.t2Ms,
      t3Ms: this.opts.t3Ms,
      // Honour the caller-supplied t1Ms: the SDL's default-init
      // actions (SRT := Initial Default; T1V := 2 * SRT) would
      // otherwise reset T1V to 6 s on every connect.
      freezeT1V: true,
    });
  }

  /** Register a callback invoked when the peer delivers I-frame info. */
  onData(callback: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(callback);
  }

  /** Register a callback invoked when the session enters Disconnected. */
  onDisconnected(callback: () => void): void {
    this.disconnectListeners.push(callback);
  }

  /**
   * Queue a payload for transmission. Resolves once the bytes are
   * accepted into the local TX queue (not once the peer has ack'd —
   * that would require a much richer API).
   */
  async write(chunk: Uint8Array): Promise<void> {
    if (this.driver.currentState !== "Connected") {
      throw new Error(`cannot write in state ${this.driver.currentState}`);
    }
    if (chunk.length === 0) return;
    this.driver.postEvent({
      name: "DL_DATA_request",
      data: chunk,
      pid: this.opts.pid,
    });
  }

  /** Initiate disconnect. Resolves when the link is fully torn down. */
  async disconnect(): Promise<void> {
    if (this.driver.currentState === "Disconnected") return;
    if (this.driver.currentState === "AwaitingRelease") {
      return new Promise<void>((resolve) => {
        const prev = this.disconnectResolver;
        this.disconnectResolver = {
          resolve: () => {
            prev?.resolve();
            resolve();
          },
        };
      });
    }
    const p = new Promise<void>((resolve) => {
      this.disconnectResolver = { resolve };
    });
    this.driver.postEvent({ name: "DL_DISCONNECT_request" });
    return p;
  }

  /** @internal — called by Ax25Stack at session creation to start SABM. */
  async _initiateConnect(): Promise<void> {
    if (this.driver.currentState !== "Disconnected") {
      throw new Error("session already started");
    }
    const p = new Promise<void>((resolve, reject) => {
      this.connectResolver = { resolve, reject };
    });
    this.driver.postEvent({ name: "DL_CONNECT_request" });
    return p;
  }

  /**
   * @internal — called by Ax25Stack for every inbound frame matching this
   * peer. `frame` was decoded at mod-8 for routing; `bytes` (when supplied)
   * is the raw wire payload, re-decoded here at this session's negotiated
   * modulo so an extended (mod-128) I/S frame's N(S)/N(R) land correctly
   * (mirrors the listener's two-pass decode and the C# receive path).
   */
  _handleFrame(frame: Ax25Frame, bytes?: Uint8Array): void {
    let f = frame;
    if (
      bytes !== undefined &&
      this.sessionContext.isExtended &&
      frame.controlExtension === null &&
      (frame.control & 0x03) !== 0x03 // not a U frame (1 octet in both modes)
    ) {
      try {
        f = decodeFrame(bytes, true);
      } catch {
        f = frame;
      }
    }
    // Classify the frame into the SDL event the dispatcher should receive. A
    // spec-violating frame (info on an S / no-info U frame; unknown U control
    // byte) maps to the matching error event so the figc4.x error-input
    // transition fires (DL-ERROR + re-establish) instead of the frame being
    // silently processed. Mirrors the C# `Ax25Adapter`, which posts
    // `Ax25FrameClassifier.Classify(frame)`.
    this.driver.postEvent(classifyFrame(f));
  }

  /** @internal — called by Ax25Stack when transport stops. */
  _forceDisconnect(): void {
    if (this.driver.currentState !== "Disconnected") {
      this.driver.setState("Disconnected");
      this.connectResolver?.reject(new Error("transport stopped"));
      this.connectResolver = null;
      this.disconnectResolver?.resolve();
      this.disconnectResolver = null;
      for (const cb of this.disconnectListeners) cb();
    }
    this.removeFromStack();
  }

  // ─── Upward-signal routing ─────────────────────────────────────────

  private handleUpwardSignal(signal: DataLinkSignal): void {
    switch (signal.type) {
      case "DL_CONNECT_confirm":
        this.hasBeenConnected = true;
        this.connectResolver?.resolve();
        this.connectResolver = null;
        return;
      case "DL_CONNECT_indication":
        // Peer-initiated connect — we don't expose an onConnectRequest
        // API in v1, so this fires only when our outbound SABM has
        // collided with a peer SABM (collision recovery, figc4.4 t41).
        this.hasBeenConnected = true;
        this.connectResolver?.resolve();
        this.connectResolver = null;
        return;
      case "DL_DISCONNECT_confirm":
      case "DL_DISCONNECT_indication":
        this.handleDisconnect(
          signal.type === "DL_DISCONNECT_indication"
            ? "peer refused connection"
            : null,
        );
        return;
      case "DL_DATA_indication":
        for (const cb of this.dataListeners) {
          cb(signal.data);
        }
        return;
      case "DL_UNIT_DATA_indication":
        // Surface UI-frame payloads on the same data listeners.
        for (const cb of this.dataListeners) {
          cb(signal.data);
        }
        return;
      case "DL_ERROR_indication":
        // Stash the error letter so a paired DL_DISCONNECT_indication
        // can reject the connect promise with a meaningful message.
        // Mapping (§C.5): G = retry limit reached; D = unexpected UA;
        // E = unexpected DM; M = info-field error; N = U/S-frame length
        // error; F = SABM collision; etc.
        this.pendingError = signal.code;
        return;
    }
  }

  private handleDisconnect(disconnectReason: string | null): void {
    // Resolve / reject pending promises depending on whether we ever
    // reached Connected. If we never connected, this is the "peer
    // refused" path — reject the connect promise.
    if (!this.hasBeenConnected && this.connectResolver) {
      const error = this.translateConnectError(disconnectReason);
      this.connectResolver.reject(error);
      this.connectResolver = null;
    }
    this.pendingError = null;
    this.disconnectResolver?.resolve();
    this.disconnectResolver = null;
    for (const cb of this.disconnectListeners) cb();
    this.removeFromStack();
  }

  /**
   * Map the most-recent DL-ERROR letter into a human-readable connect
   * failure. The hand-rolled implementation rejected with two distinct
   * messages: "/refused/" on DM and "/retry limit/" on N2 exhaustion.
   * Those substrings live in the existing test suite, so we preserve
   * them here.
   */
  private translateConnectError(disconnectReason: string | null): Error {
    if (this.pendingError === "G") {
      return new Error(
        `SABM retry limit (N2=${this.opts.n2}) exhausted (DL-ERROR G)`,
      );
    }
    return new Error(
      disconnectReason ?? "peer refused connection (DM received)",
    );
  }
}

// ─── Stack: routes inbound frames to sessions, multiplexes outbound ─────

/**
 * Holds the transport, runs the inbound demux loop, and is the factory
 * for new {@link Ax25Session}s.
 */
export class Ax25Stack {
  private readonly transport: Ax25Transport;
  private readonly sessions = new Map<string, Ax25Session>();
  private started = false;

  constructor(transport: Ax25Transport) {
    this.transport = transport;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.transport.start((bytes) => this.onInboundFrame(bytes));
    this.started = true;
  }

  /**
   * Initiate a connected-mode session to `to`. Resolves with the session
   * once the SABM/UA handshake completes; rejects on N2 exhaustion or
   * peer DM.
   *
   * `via` is the digipeater path; it's NOT supported in v1 and will throw.
   */
  async connect(args: {
    from: string | Callsign;
    to: string | Callsign;
    via?: string[];
    options?: Ax25SessionOptions;
  }): Promise<Ax25Session> {
    if (!this.started) {
      throw new Error("stack not started — call start() first");
    }
    if (args.via && args.via.length > 0) {
      throw new Error("digipeater paths (`via`) are not implemented in v1");
    }
    const from =
      typeof args.from === "string" ? Callsign.parse(args.from) : args.from;
    const to = typeof args.to === "string" ? Callsign.parse(args.to) : args.to;
    const key = sessionKey(from, to);
    if (this.sessions.has(key)) {
      throw new Error(`session ${key} already exists`);
    }
    const session = new Ax25Session(
      from,
      to,
      (frame) => this.transport.send(encodeFrame(frame)),
      () => {
        this.sessions.delete(key);
      },
      args.options ?? {},
    );
    this.sessions.set(key, session);
    try {
      await session._initiateConnect();
    } catch (err) {
      this.sessions.delete(key);
      throw err;
    }
    return session;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session._forceDisconnect();
    }
    this.sessions.clear();
    if (this.started) {
      await this.transport.stop();
      this.started = false;
    }
  }

  private onInboundFrame(bytes: Uint8Array): void {
    let frame: Ax25Frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return; // malformed — drop.
    }
    // Route by (local=destination, peer=source).
    const local = frame.destination.callsign;
    const peer = frame.source.callsign;
    const key = sessionKey(local, peer);
    const session = this.sessions.get(key);
    if (session) {
      // Pass the raw bytes so the session can re-decode an extended (mod-128)
      // I/S frame at its negotiated modulo — the routing decode above is mod-8.
      session._handleFrame(frame, bytes);
      return;
    }
    // No matching session. We don't currently auto-accept inbound SABMs;
    // that would require an "onConnectRequest" API which is out of scope.
    // Spec-correct behaviour would be to reply DM; we silently drop.
  }
}

function sessionKey(local: Callsign, peer: Callsign): string {
  return `${local.toString()}__${peer.toString()}`;
}
