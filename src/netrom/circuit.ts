import { Callsign } from "../callsign.js";
import { buildConnectRequestInfo } from "./connect-request-info.js";
import {
  NetRomCircuitCloseReason,
  NetRomCircuitState,
} from "./circuit-state.js";
import {
  type NetRomCircuitOptions,
  type ResolvedNetRomCircuitOptions,
  resolveCircuitOptions,
} from "./circuit-options.js";
import type { NetRomNetworkHeader } from "./network-header.js";
import type { NetRomPacket } from "./packet.js";
import {
  NetRomOpcode,
  NetRomTransportFlags,
  type NetRomTransportHeader,
  transportHeaderChoke,
  transportHeaderMoreFollows,
  transportHeaderNak,
} from "./transport-header.js";

/**
 * One end of a NET/ROM L4 virtual circuit: a hand-written, end-to-end
 * sliding-window transport (connect / info / disconnect with negotiated window,
 * 8-bit sequence numbers, choke flow control, selective-NAK retransmit, and L4
 * fragment/reassembly at 236 bytes). It runs *above* the AX.25 interlink — it
 * emits {@link NetRomPacket}s through a sink the host wires to
 * `Ax25Listener.sendData(…, pid 0xCF)`, and is fed inbound datagrams via
 * {@link onPacket}; it knows nothing about AX.25 itself, keeping the NET/ROM
 * module free of host/transport dependencies.
 *
 * **Not derived from SDL.** NET/ROM has no normative SDL figures and BPQ is the
 * de-facto reference, so per the research this transport is hand-written with
 * hard tests rather than routed through the ax25sdl pipeline. The state machine
 * is the conventional one (Disconnected / Connecting / Connected / Disconnecting,
 * {@link NetRomCircuitState}); divergence-prone constants (window, timers,
 * retries, TTL, fragment size) are named knobs on {@link NetRomCircuitOptions}.
 *
 * **Time + threading.** All timing is via the injected `now()` clock returning
 * epoch ms (the TS analogue of the C# `TimeProvider`, §2.7); the owner drives
 * retransmits by calling {@link tick} at the clock's cadence (the
 * {@link CircuitManager} does this). The C# class serialises every public method
 * under one lock because its inbound datagrams, application sends, and timer tick
 * can race across threads; this TS port runs in the single-threaded JS model (the
 * node host pumps inbound, sends, and ticks on one event loop) so no lock is
 * needed — the ordered method calls are the serialisation. The behaviour is
 * otherwise a faithful port.
 *
 * Mirrors `Packet.NetRom.Transport.NetRomCircuit` on the C# side.
 */
export class NetRomCircuit {
  private readonly options: ResolvedNetRomCircuitOptions;
  private readonly now: () => number;

  // Identity. "Local" index/id are the values WE chose and put in our outgoing
  // headers' index/id so the peer addresses replies to us; "remote" index/id are
  // the values the PEER chose (learned from its Connect / Connect-Ack) that we
  // stamp into datagrams we send it.
  private readonly _localIndex: number;
  private readonly _localId: number;
  private remoteIndex = 0;
  private remoteId = 0;

  private readonly localNode: Callsign; // our node callsign (L3 origin on our sends)
  private readonly _remoteNode: Callsign; // the far node (L3 destination on our sends)

  private _state: NetRomCircuitState = NetRomCircuitState.Disconnected;

  // Negotiated window (set at connect time).
  private _window: number;

  // Send side — 8-bit sequence space (mod 256).
  private vs = 0; // next send sequence to allocate
  private va = 0; // oldest unacknowledged sequence
  private readonly sendQueue: Fragment[] = []; // fragments waiting for window room
  private readonly unacked: Unacked[] = []; // in-flight Information, oldest first

  // Receive side.
  private vr = 0; // next send sequence we expect from the peer
  private reassembly: number[] = []; // accumulates more-follows fragments

  // Flow control.
  private _peerChoked = false; // peer told us to stop sending Info
  private localChoked = false; // we told the peer to stop (receive backlog)
  private pendingDeliveries = 0; // received-but-not-yet-delivered count

  // Connect/disconnect retransmit bookkeeping (Information uses per-message
  // timers inside `unacked`). The control frame is rebuilt on each retry, so no
  // bytes are cached.
  private controlDeadline = 0;
  private controlTimerArmed = false;
  private controlRetries = 0;

  // The end user the circuit is on behalf of (carried in the Connect Request).
  private connectUser: Callsign = new Callsign("", 0);

  /** The single sink that emits an outbound datagram. The owner (the
   * {@link CircuitManager}) wires it to ship the bytes in an interlink I-frame
   * (PID 0xCF). Set once before driving the circuit. Mirrors the C# `SendPacket`
   * property. */
  sendPacket: ((packet: NetRomPacket) => void) | null = null;

  // Multicast listener lists — the C# side uses `event Action<...>` so the
  // manager AND the consumer can both subscribe without clobbering each other
  // (the manager subscribes Closed to deregister; the consumer subscribes for the
  // notification). TS has no multicast delegates, so these are arrays + `on*`
  // registration helpers.
  private readonly dataReceivedListeners: Array<(data: Uint8Array) => void> = [];
  private readonly connectedListeners: Array<() => void> = [];
  private readonly closedListeners: Array<
    (reason: NetRomCircuitCloseReason) => void
  > = [];

  /**
   * Construct a circuit end. The owner allocates the local index/id and supplies
   * the node callsigns for the L3 header. Mirrors the C# constructor.
   *
   * @param now Injected clock returning epoch ms (timer deadlines). Defaults to
   *   `Date.now` (the TS analogue of the C# `TimeProvider.System`).
   */
  constructor(
    localIndex: number,
    localId: number,
    localNode: Callsign,
    remoteNode: Callsign,
    options?: NetRomCircuitOptions,
    now: () => number = Date.now,
  ) {
    this._localIndex = localIndex & 0xff;
    this._localId = localId & 0xff;
    this.localNode = localNode;
    this._remoteNode = remoteNode;
    this.options = resolveCircuitOptions(options);
    this.now = now;
    this._window = this.options.windowSize;
  }

  /** Our circuit-table index (the value the peer addresses replies to). */
  get localIndex(): number {
    return this._localIndex;
  }

  /** Our circuit-table id (qualifies {@link localIndex}). */
  get localId(): number {
    return this._localId;
  }

  /** The far node this circuit reaches. */
  get remoteNode(): Callsign {
    return this._remoteNode;
  }

  /** The current lifecycle state (snapshot). */
  get state(): NetRomCircuitState {
    return this._state;
  }

  /** The negotiated send-window size (after connect). */
  get window(): number {
    return this._window;
  }

  /** True while the peer has us choked (we are holding Information back). */
  get peerChoked(): boolean {
    return this._peerChoked;
  }

  /** Send-side V(s): the next send sequence to allocate (mod 256). Exposed for
   * tests/diagnostics, mirroring how the AX.25 session context surfaces V(s)/V(a)
   * to the conformance harness. */
  get sendState(): number {
    return this.vs;
  }

  /** Send-side V(a): the oldest unacknowledged sequence (mod 256). The window's
   * lower edge; see {@link sendState}. */
  get ackState(): number {
    return this.va;
  }

  /** Receive-side V(r): the next send sequence expected from the peer (mod 256). */
  get receiveState(): number {
    return this.vr;
  }

  /** Subscribe to reassembled user data delivered upward — one call per completed
   * logical frame (fragments are joined first). Mirrors the C# `DataReceived`
   * event. */
  onData(listener: (data: Uint8Array) => void): void {
    this.dataReceivedListeners.push(listener);
  }

  /** Subscribe to the one-shot transition to {@link NetRomCircuitState.Connected}
   * (our connect accepted, or we accepted an inbound connect). Mirrors the C#
   * `Connected` event. */
  onConnected(listener: () => void): void {
    this.connectedListeners.push(listener);
  }

  /** Subscribe to the close notification (the circuit reached
   * {@link NetRomCircuitState.Disconnected}), with the reason. The manager
   * subscribes this to deregister the circuit; consumers subscribe it for the
   * close notification. Mirrors the C# `Closed` event. */
  onClosed(listener: (reason: NetRomCircuitCloseReason) => void): void {
    this.closedListeners.push(listener);
  }

  // ─── Origination ────────────────────────────────────────────────────

  /**
   * Originate the circuit: send a Connect Request (proposing our window) carrying
   * the originating user + node callsigns, and arm the connect retransmit timer.
   * No-op if not in {@link NetRomCircuitState.Disconnected}.
   *
   * @param originatingUser The end user the circuit is on behalf of (carried in
   *   the Connect Request payload, after the originating node).
   */
  connect(originatingUser: Callsign): void {
    if (this._state !== NetRomCircuitState.Disconnected) {
      return;
    }
    this._state = NetRomCircuitState.Connecting;
    this.controlRetries = 0;
    this.connectUser = originatingUser;
    this.sendConnectRequest();
    this.armControlTimer();
  }

  // ─── Application send ───────────────────────────────────────────────

  /**
   * Queue user data for transmission. Fragments it into
   * ≤{@link NetRomCircuitOptions.fragmentSize} Information messages (more-follows
   * on all but the last) and pushes as many as the window + peer-choke allow onto
   * the wire now; the rest drain as acks arrive. No-op (data dropped) if the
   * circuit is not connected.
   */
  send(data: Uint8Array): void {
    if (this._state !== NetRomCircuitState.Connected || data.length === 0) {
      return;
    }

    // Fragment into ≤fragmentSize chunks. Each fragment carries more-follows
    // except the last of THIS logical frame; the flag is stored alongside the
    // bytes so it survives across multiple send() calls in the queue.
    const frag = Math.max(1, this.options.fragmentSize);
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(frag, data.length - offset);
      const more = offset + take < data.length;
      this.sendQueue.push({
        bytes: data.slice(offset, offset + take),
        moreFollows: more,
      });
      offset += take;
    }

    this.pumpSendQueue();
  }

  // ─── Disconnect ─────────────────────────────────────────────────────

  /**
   * Tear the circuit down: send a Disconnect Request and arm its retransmit
   * timer. If not connected, closes locally at once. Idempotent.
   */
  disconnect(): void {
    switch (this._state) {
      case NetRomCircuitState.Disconnected:
      case NetRomCircuitState.Disconnecting:
        return;
      case NetRomCircuitState.Connecting:
        // Never established — close locally; nothing to disconnect-ack.
        this.close(NetRomCircuitCloseReason.Normal);
        return;
      case NetRomCircuitState.Connected:
        this._state = NetRomCircuitState.Disconnecting;
        this.controlRetries = 0;
        this.sendDisconnectRequest();
        this.armControlTimer();
        return;
    }
  }

  // ─── Inbound ────────────────────────────────────────────────────────

  /**
   * Feed an inbound datagram (already parsed from an interlink I-frame's info
   * field) addressed to this circuit. Drives the FSM: connect/ack, info (with ack
   * + choke + NAK + reassembly), disconnect/ack. Tolerant of any opcode — an
   * unexpected message for the current state is ignored, never throws.
   *
   * Mirrors the C# `OnPacket`.
   */
  onPacket(packet: NetRomPacket): void {
    const t = packet.transport;
    switch (t.opcode) {
      case NetRomOpcode.ConnectRequest:
        this.onConnectRequest(t);
        break;
      case NetRomOpcode.ConnectAcknowledge:
        this.onConnectAcknowledge(t);
        break;
      case NetRomOpcode.DisconnectRequest:
        this.onDisconnectRequest(t);
        break;
      case NetRomOpcode.DisconnectAcknowledge:
        this.onDisconnectAcknowledge(t);
        break;
      case NetRomOpcode.Information:
        this.onInformation(t, packet.payload);
        break;
      case NetRomOpcode.InformationAcknowledge:
        this.onInformationAcknowledge(t);
        break;
      default:
        // Unknown opcode — ignore.
        break;
    }
  }

  /**
   * Accept an inbound circuit: this end was created in response to a Connect
   * Request, so adopt the peer's index/id and proposed window, move to Connected,
   * and send the Connect Acknowledge. Used by {@link CircuitManager} when it mints
   * a circuit for an incoming connect.
   *
   * Mirrors the C# `AcceptInbound` (internal).
   */
  acceptInbound(peerIndex: number, peerId: number, proposedWindow: number): void {
    this.remoteIndex = peerIndex & 0xff;
    this.remoteId = peerId & 0xff;
    this._window = clamp(
      Math.min(
        proposedWindow <= 0 ? this.options.windowSize : proposedWindow,
        this.options.windowSize,
      ),
      1,
      127,
    );
    this._state = NetRomCircuitState.Connected;
    this.sendConnectAcknowledge(false);
    this.fireConnected();
  }

  /**
   * Refuse an inbound circuit: send a Connect Acknowledge with the refuse (choke)
   * bit set and stay disconnected. Used by the manager when it cannot accept (e.g.
   * no listener / table full).
   *
   * Mirrors the C# `RefuseInbound` (internal).
   */
  refuseInbound(peerIndex: number, peerId: number): void {
    this.remoteIndex = peerIndex & 0xff;
    this.remoteId = peerId & 0xff;
    this.sendConnectAcknowledge(true);
    this._state = NetRomCircuitState.Disconnected;
  }

  // ─── Timer ──────────────────────────────────────────────────────────

  /**
   * Drive time-based behaviour: retransmit the oldest unacknowledged Information
   * message (or the pending connect/disconnect control message) whose timeout has
   * elapsed, failing the circuit once retries are exhausted. The owner calls this
   * at the clock cadence; it is cheap when nothing is due.
   *
   * Mirrors the C# `Tick`.
   */
  tick(): void {
    const now = this.now();

    // Control (connect/disconnect) retransmit.
    if (this.controlTimerArmed && now >= this.controlDeadline) {
      if (this.controlRetries >= this.options.maxRetries) {
        this.controlTimerArmed = false;
        this.close(NetRomCircuitCloseReason.Timeout);
        return;
      }
      this.controlRetries++;
      switch (this._state) {
        case NetRomCircuitState.Connecting:
          this.sendConnectRequest();
          break;
        case NetRomCircuitState.Disconnecting:
          this.sendDisconnectRequest();
          break;
      }
      this.armControlTimer();
    }

    // Information retransmit — oldest unacked first.
    if (
      this._state === NetRomCircuitState.Connected &&
      this.unacked.length > 0
    ) {
      const oldest = this.unacked[0]!;
      if (now >= oldest.sentAt + this.options.retransmitTimeoutMs) {
        if (oldest.retries >= this.options.maxRetries) {
          this.close(NetRomCircuitCloseReason.Timeout);
          return;
        }
        // Retransmit every in-flight frame from the oldest (go-back style),
        // bumping their timers — NET/ROM has no cumulative-ack guarantee the peer
        // kept later frames after a gap.
        for (let i = 0; i < this.unacked.length; i++) {
          const u = this.unacked[i]!;
          this.sendInformation(u.sequence, u.payload, u.moreFollows);
          this.unacked[i] = { ...u, sentAt: now, retries: u.retries + 1 };
        }
      }
    }
  }

  // ─── Receive-side flow control ──────────────────────────────────────

  /**
   * Tell the circuit of the consumer's drain progress: call after delivering
   * received data so the circuit can release a previously-asserted choke once its
   * receive backlog drains below the threshold. The node bridge delivers
   * synchronously so this is usually a no-op, but it is the seam for real
   * backpressure.
   *
   * Mirrors the C# `OnDeliveryDrained`.
   */
  onDeliveryDrained(): void {
    if (this.pendingDeliveries > 0) {
      this.pendingDeliveries--;
    }
    this.maybeReleaseChoke();
  }

  // ─── FSM handlers ───────────────────────────────────────────────────

  private onConnectAcknowledge(t: NetRomTransportHeader): void {
    if (this._state !== NetRomCircuitState.Connecting) {
      return;
    }

    // The ack names OUR index/id in its index/id fields (it is addressed to us),
    // and the peer's own index/id are carried in the TX/RX sequence slots on a
    // connect-ack (the canonical overload: it tells us how to address it back).
    this.remoteIndex = t.txSequence;
    this.remoteId = t.rxSequence;

    this.controlTimerArmed = false;

    // Bit-7 (choke) on a connect-ack means refused.
    if (transportHeaderChoke(t)) {
      this.close(NetRomCircuitCloseReason.Refused);
      return;
    }

    // Window negotiation: our Connect Request proposed options.windowSize and we
    // keep that as our send ceiling. (The far end has independently accepted a
    // window ≤ its own proposal; vanilla NET/ROM does not require us to shrink
    // ours below what we proposed, and our send window is bounded by `window`
    // either way.)
    this._state = NetRomCircuitState.Connected;
    this.fireConnected();
    this.pumpSendQueue();
  }

  private onConnectRequest(_t: NetRomTransportHeader): void {
    // A retransmitted Connect Request after we're already up: just re-ack.
    if (this._state === NetRomCircuitState.Connected) {
      this.sendConnectAcknowledge(false);
      return;
    }
    // Otherwise the manager owns inbound-connect minting (acceptInbound /
    // refuseInbound); a bare circuit ignores an unexpected request.
  }

  private onDisconnectRequest(_t: NetRomTransportHeader): void {
    // Acknowledge and close, from any live state.
    this.sendDisconnectAcknowledge();
    if (this._state !== NetRomCircuitState.Disconnected) {
      this.close(NetRomCircuitCloseReason.Normal);
    }
  }

  private onDisconnectAcknowledge(_t: NetRomTransportHeader): void {
    if (this._state === NetRomCircuitState.Disconnecting) {
      this.controlTimerArmed = false;
      this.close(NetRomCircuitCloseReason.Normal);
    }
  }

  private onInformation(t: NetRomTransportHeader, payload: Uint8Array): void {
    if (this._state !== NetRomCircuitState.Connected) {
      // Information before connect / after disconnect — drop.
      return;
    }

    // First, absorb the piggybacked ack (their RX = next seq they expect from us).
    this.absorbAck(t.rxSequence);

    // Honour an inbound choke / choke-release flag on the Information message.
    this.applyPeerChoke(transportHeaderChoke(t));

    // In-order delivery: accept only the frame we expect (NET/ROM mod-256). A NAK
    // is the selective-retransmit mechanism for gaps; on a duplicate or future
    // frame we simply re-ack our current expected sequence.
    if (t.txSequence === this.vr) {
      // Accept.
      this.vr = (this.vr + 1) & 0xff;

      if (payload.length > 0) {
        for (const b of payload) {
          this.reassembly.push(b);
        }
      }

      if (!transportHeaderMoreFollows(t) && this.reassembly.length > 0) {
        // Logical frame complete — deliver upward.
        const whole = Uint8Array.from(this.reassembly);
        this.reassembly = [];

        // Backpressure accounting only matters when a choke threshold is
        // configured; otherwise the consumer drains synchronously (the node
        // bridge does) and we never accumulate a backlog. A host that can stall
        // its reader sets chokeThreshold and calls onDeliveryDrained.
        if (this.options.chokeThreshold > 0) {
          this.pendingDeliveries++;
        }
        this.fireDataReceived(whole);
        this.maybeAssertChoke();
      }

      this.sendInformationAcknowledge(false);
    } else {
      // Out-of-sequence. If it's a future frame (a gap), NAK the one we want; a
      // stale duplicate just gets a plain ack so the sender advances.
      const future = mod256After(t.txSequence, this.vr);
      this.sendInformationAcknowledge(future);
    }
  }

  private onInformationAcknowledge(t: NetRomTransportHeader): void {
    if (this._state !== NetRomCircuitState.Connected) {
      return;
    }

    this.applyPeerChoke(transportHeaderChoke(t));

    if (transportHeaderNak(t)) {
      // Selective retransmit: the peer wants the frame named by its RX seq (the
      // next it expects). Retransmit that frame (and following in-flight)
      // immediately, then absorb the implied ack of everything before it.
      this.absorbAck(t.rxSequence);
      this.retransmitFrom(t.rxSequence);
    } else {
      this.absorbAck(t.rxSequence);
    }

    this.pumpSendQueue();
  }

  // ─── Send helpers ───────────────────────────────────────────────────

  private sendConnectRequest(): void {
    // Connect Request: index/id are OUR own (so the peer learns how to address
    // us). The PROPOSED WINDOW and the originating user/node callsigns travel in
    // the INFO field, NOT the transport header — see connect-request-info for the
    // wire layout (this is the de-facto NET/ROM form LinBPQ originates + accepts,
    // verified on the wire; #308 interop follow-up).
    const t: NetRomTransportHeader = {
      circuitIndex: this._localIndex,
      circuitId: this._localId,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.ConnectRequest,
      flags: NetRomTransportFlags.None,
    };

    const user = this.connectUser.base.length === 0 ? this.localNode : this.connectUser;
    this.emit(
      t,
      buildConnectRequestInfo(
        clamp(this.options.windowSize, 1, 127),
        user,
        this.localNode,
      ),
    );
  }

  private sendConnectAcknowledge(refused: boolean): void {
    // Connect Acknowledge: addressed to the peer (its index/id), and carries OUR
    // index/id in the TX/RX slots so the peer can address us. TX also doubles as
    // the accepted window. Bit-7 set = refused.
    const t: NetRomTransportHeader = {
      circuitIndex: this.remoteIndex,
      circuitId: this.remoteId,
      txSequence: this._localIndex,
      rxSequence: this._localId,
      opcode: NetRomOpcode.ConnectAcknowledge,
      flags: refused ? NetRomTransportFlags.Choke : NetRomTransportFlags.None,
    };
    this.emit(t, EMPTY_PAYLOAD);
  }

  private sendDisconnectRequest(): void {
    const t: NetRomTransportHeader = {
      circuitIndex: this.remoteIndex,
      circuitId: this.remoteId,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.DisconnectRequest,
      flags: NetRomTransportFlags.None,
    };
    this.emit(t, EMPTY_PAYLOAD);
  }

  private sendDisconnectAcknowledge(): void {
    const t: NetRomTransportHeader = {
      circuitIndex: this.remoteIndex,
      circuitId: this.remoteId,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.DisconnectAcknowledge,
      flags: NetRomTransportFlags.None,
    };
    this.emit(t, EMPTY_PAYLOAD);
  }

  private sendInformation(
    seq: number,
    payload: Uint8Array,
    moreFollows: boolean,
  ): void {
    let flags = NetRomTransportFlags.None;
    if (moreFollows) {
      flags |= NetRomTransportFlags.MoreFollows;
    }
    if (this.localChoked) {
      flags |= NetRomTransportFlags.Choke;
    }
    const t: NetRomTransportHeader = {
      circuitIndex: this.remoteIndex,
      circuitId: this.remoteId,
      txSequence: seq,
      rxSequence: this.vr, // piggyback our receive expectation
      opcode: NetRomOpcode.Information,
      flags,
    };
    this.emit(t, payload);
  }

  private sendInformationAcknowledge(nak: boolean): void {
    let flags = NetRomTransportFlags.None;
    if (nak) {
      flags |= NetRomTransportFlags.Nak;
    }
    if (this.localChoked) {
      flags |= NetRomTransportFlags.Choke;
    }
    const t: NetRomTransportHeader = {
      circuitIndex: this.remoteIndex,
      circuitId: this.remoteId,
      txSequence: 0,
      rxSequence: this.vr,
      opcode: NetRomOpcode.InformationAcknowledge,
      flags,
    };
    this.emit(t, EMPTY_PAYLOAD);
  }

  private emit(transport: NetRomTransportHeader, payload: Uint8Array): void {
    const network: NetRomNetworkHeader = {
      origin: this.localNode,
      destination: this._remoteNode,
      timeToLive: this.options.timeToLive,
    };
    const packet: NetRomPacket = { network, transport, payload };
    this.sendPacket?.(packet);
  }

  // ─── Window + ack mechanics ─────────────────────────────────────────

  private pumpSendQueue(): void {
    if (this._state !== NetRomCircuitState.Connected || this._peerChoked) {
      return;
    }

    const now = this.now();
    while (this.sendQueue.length > 0 && this.inFlight() < this._window) {
      const fragment = this.sendQueue.shift()!;
      const seq = this.vs;
      this.vs = (this.vs + 1) & 0xff;
      this.unacked.push({
        sequence: seq,
        payload: fragment.bytes,
        moreFollows: fragment.moreFollows,
        sentAt: now,
        retries: 0,
      });
      this.sendInformation(seq, fragment.bytes, fragment.moreFollows);
    }
  }

  private inFlight(): number {
    return this.unacked.length;
  }

  // Absorb a cumulative ack: the peer expects `expected` next, so every in-flight
  // sequence strictly before `expected` (mod 256, within the window) is acked.
  private absorbAck(expected: number): void {
    if (this.unacked.length === 0) {
      this.va = expected;
      return;
    }

    // Remove every unacked frame whose sequence is "before" expected.
    removeAll(this.unacked, (u) => seqAcked(u.sequence, expected));
    this.va = expected;

    // Window opened up — try to send more.
    this.pumpSendQueue();
  }

  private retransmitFrom(seq: number): void {
    // Selective-NAK: resend the named frame and every in-flight frame after it
    // (the peer dropped a frame and the ones it kept after a gap can't be acked
    // until the gap fills).
    const now = this.now();
    for (let i = 0; i < this.unacked.length; i++) {
      const u = this.unacked[i]!;
      if (u.sequence === seq || mod256After(u.sequence, seq)) {
        this.sendInformation(u.sequence, u.payload, u.moreFollows);
        this.unacked[i] = { ...u, sentAt: now, retries: u.retries + 1 };
      }
    }
  }

  // ─── Choke ──────────────────────────────────────────────────────────

  private applyPeerChoke(choke: boolean): void {
    if (choke && !this._peerChoked) {
      this._peerChoked = true;
    } else if (!choke && this._peerChoked) {
      this._peerChoked = false;
      this.pumpSendQueue(); // peer released choke — resume sending
    }
  }

  private maybeAssertChoke(): void {
    if (
      this.options.chokeThreshold > 0 &&
      this.pendingDeliveries >= this.options.chokeThreshold &&
      !this.localChoked
    ) {
      this.localChoked = true;
    }
  }

  private maybeReleaseChoke(): void {
    if (this.localChoked && this.pendingDeliveries < this.options.chokeThreshold) {
      this.localChoked = false;
      // Tell the peer it may resume: a plain InfoAck with choke clear.
      if (this._state === NetRomCircuitState.Connected) {
        this.sendInformationAcknowledge(false);
      }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  private armControlTimer(): void {
    this.controlDeadline = this.now() + this.options.retransmitTimeoutMs;
    this.controlTimerArmed = true;
  }

  private close(reason: NetRomCircuitCloseReason): void {
    if (this._state === NetRomCircuitState.Disconnected) {
      return;
    }
    this._state = NetRomCircuitState.Disconnected;
    this.controlTimerArmed = false;
    this.unacked.length = 0;
    this.sendQueue.length = 0;
    this.reassembly = [];
    this.fireClosed(reason);
  }

  // ─── Listener fan-out ───────────────────────────────────────────────

  private fireDataReceived(data: Uint8Array): void {
    for (const l of [...this.dataReceivedListeners]) {
      l(data);
    }
  }

  private fireConnected(): void {
    for (const l of [...this.connectedListeners]) {
      l();
    }
  }

  private fireClosed(reason: NetRomCircuitCloseReason): void {
    for (const l of [...this.closedListeners]) {
      l(reason);
    }
  }
}

/** An in-flight Information message awaiting ack. Mirrors the C# `Unacked` record. */
interface Unacked {
  readonly sequence: number;
  readonly payload: Uint8Array;
  readonly moreFollows: boolean;
  readonly sentAt: number;
  readonly retries: number;
}

/** A queued send fragment. Mirrors the C# `Fragment` record. */
interface Fragment {
  readonly bytes: Uint8Array;
  readonly moreFollows: boolean;
}

const EMPTY_PAYLOAD = new Uint8Array(0);

/** Clamp `value` into `[lo, hi]` (the TS analogue of C# `Math.Clamp`). */
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * True if sequence `seq` is acknowledged by a peer that now expects `expected`:
 * i.e. seq is in [va, expected) walking forward mod 256, bounded by the window.
 * Mirrors the C# `SeqAcked`.
 */
function seqAcked(seq: number, expected: number): boolean {
  // Distance from seq to expected, walking forward mod 256.
  const dist = (expected - seq) & 0xff;
  // Acked iff expected is strictly after seq within a window-sized horizon.
  return dist >= 1 && dist <= 128;
}

/**
 * True if `a` is strictly after `b` within a half-window horizon (mod 256).
 * Mirrors the C# `Mod256After`.
 */
function mod256After(a: number, b: number): boolean {
  const dist = (a - b) & 0xff;
  return dist >= 1 && dist <= 128;
}

/** In-place remove every element of `arr` matching `predicate` (the TS analogue
 *  of C# `List<T>.RemoveAll`). */
function removeAll<T>(arr: T[], predicate: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < arr.length; read++) {
    if (!predicate(arr[read]!)) {
      arr[write++] = arr[read]!;
    }
  }
  arr.length = write;
}
