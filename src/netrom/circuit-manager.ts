import type { Callsign } from "../callsign.js";
import { tryParseConnectRequestInfo } from "./connect-request-info.js";
import { NetRomCircuit } from "./circuit.js";
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
} from "./transport-header.js";

/**
 * Carries an inbound NET/ROM circuit request to an
 * {@link CircuitManager.onIncomingCircuit} handler. The handler accepts
 * ({@link CircuitManager.acceptIncoming}) or refuses
 * ({@link CircuitManager.refuseIncoming}) it.
 *
 * Mirrors `Packet.NetRom.Transport.IncomingCircuitEventArgs` on the C# side.
 */
export interface IncomingCircuitEvent {
  /** The freshly-minted circuit (registered, not yet acknowledged). */
  readonly circuit: NetRomCircuit;
  /** The far node that originated the circuit. */
  readonly remoteNode: Callsign;
  /** The end user the circuit is on behalf of (from the connect payload). */
  readonly originatingUser: Callsign;
  /** The peer's circuit-table index (to address replies to it). */
  readonly peerIndex: number;
  /** The peer's circuit-table id. */
  readonly peerId: number;
  /** The window size the peer proposed in its Connect Request. */
  readonly proposedWindow: number;
}

/**
 * Owns this node's NET/ROM L4 circuit table: mints local circuits (allocating the
 * circuit index/id pair), demultiplexes inbound datagrams to the right
 * {@link NetRomCircuit}, accepts/refuses inbound connect requests, and drives
 * every circuit's retransmit timer off one {@link tick}. It is the protocol-side
 * seam the node host plugs into: the host supplies a {@link sendPacket} sink (wire
 * a datagram onto the interlink to its destination node) and subscribes
 * {@link onIncomingCircuit} (a remote opened a circuit to us).
 *
 * **Host-free.** Like {@link NetRomCircuit}, the manager has no AX.25 / node-host
 * dependency — it speaks only {@link NetRomPacket} in and out, so it is fully
 * unit-testable and the same instance can sit behind any transport.
 *
 * **Demultiplexing.** A datagram's transport header names *our* circuit (the
 * index/id we handed the peer at connect time), so inbound routing is a table
 * lookup on `(index,id)`. A Connect Request, by contrast, names the *peer's*
 * circuit in those fields (we don't have one yet) — so a Connect Request that
 * doesn't match an existing circuit mints a fresh inbound circuit and raises
 * {@link onIncomingCircuit} for the host to accept or refuse.
 *
 * **Time.** The C# manager can self-drive its tick off a `TimeProvider` timer; in
 * the single-threaded TS model the embedder calls {@link tick} from a `setInterval`
 * (keeping the library free of ambient timers and trivially testable — the same
 * choice {@link NetRomService} makes for its sweep). The deterministic test path
 * calls {@link tick} after advancing the injected clock.
 *
 * Mirrors `Packet.NetRom.Transport.CircuitManager` on the C# side.
 */
export class CircuitManager {
  private _localNode: Callsign;
  private readonly options: NetRomCircuitOptions | undefined;
  private readonly resolvedOptions: ResolvedNetRomCircuitOptions;
  private readonly now: () => number;

  // Our circuits keyed by the (index,id) we allocated — the key the peer stamps
  // into datagrams addressed to us.
  private readonly byLocalKey = new Map<string, NetRomCircuit>();
  // Inbound circuits also keyed by the PEER's identity (origin node + the peer's
  // own index/id from its Connect Request) so a RETRANSMITTED Connect Request —
  // its header names the peer's circuit, not ours, so it can't match byLocalKey —
  // re-acks the existing circuit instead of minting a duplicate.
  private readonly byPeerKey = new Map<string, NetRomCircuit>();
  // Reverse map so deregistration can drop a circuit's peer-key entry without a
  // value scan.
  private readonly peerKeyOf = new Map<NetRomCircuit, string>();
  private nextIndex = 0;
  private nextId = 0;

  /** The sink the host wires to ship a datagram onto the interlink toward
   * `packet.network.destination`. Must be set before any circuit transmits.
   * Mirrors the C# `SendPacket` property. */
  sendPacket: ((packet: NetRomPacket) => void) | null = null;

  private readonly incomingCircuitListeners: Array<
    (event: IncomingCircuitEvent) => void
  > = [];

  /**
   * Construct the manager for a node. Mirrors the C# constructor (its optional
   * self-driving `tickInterval` is dropped — the TS embedder drives {@link tick}
   * from a `setInterval`, keeping the library free of ambient timers).
   *
   * @param now Injected clock returning epoch ms. Defaults to `Date.now` (the TS
   *   analogue of the C# `TimeProvider.System`).
   */
  constructor(localNode: Callsign, options?: NetRomCircuitOptions, now: () => number = Date.now) {
    this._localNode = localNode;
    this.options = options;
    this.resolvedOptions = resolveCircuitOptions(options);
    this.now = now;
  }

  /** The live circuits (snapshot), for surfacing / tests. Mirrors the C#
   * `Circuits` property. */
  get circuits(): NetRomCircuit[] {
    return [...this.byLocalKey.values()];
  }

  /**
   * Subscribe to inbound circuit requests. The handler decides whether to accept
   * (call {@link acceptIncoming}) or refuse ({@link refuseIncoming}) and, on
   * accept, wires the circuit's data/close callbacks + bridges it. The circuit is
   * freshly minted and not yet acknowledged when this fires. Mirrors the C#
   * `IncomingCircuit` event.
   */
  onIncomingCircuit(listener: (event: IncomingCircuitEvent) => void): void {
    this.incomingCircuitListeners.push(listener);
  }

  /**
   * Set the local node callsign stamped into the L3 origin of circuits this
   * manager mints. The node host calls this once the node identity is known (at
   * first port attach) — circuits are minted after, so they carry it. Affects
   * circuits opened *after* the call (existing circuits keep their origin).
   *
   * Mirrors the C# `SetLocalNode`.
   */
  setLocalNode(node: Callsign): void {
    this._localNode = node;
  }

  /**
   * Mint a local circuit to `remoteNode`, allocate its (index,id), register it,
   * and wire its packet sink + auto-deregistration on close. The caller then sets
   * the circuit's data/connected/closed callbacks and calls
   * {@link NetRomCircuit.connect}.
   *
   * Mirrors the C# `OpenCircuit`.
   */
  openCircuit(remoteNode: Callsign): NetRomCircuit {
    const [index, id] = this.allocateKey();
    const circuit = new NetRomCircuit(
      index,
      id,
      this._localNode,
      remoteNode,
      this.options,
      this.now,
    );
    circuit.sendPacket = (p) => this.sendPacket?.(p);
    this.register(circuit);
    return circuit;
  }

  /**
   * Feed an inbound datagram (parsed from an interlink I-frame's info field).
   * Routes it to the addressed circuit, or, for a Connect Request with no matching
   * circuit, mints an inbound circuit and raises {@link onIncomingCircuit}.
   * Tolerant of stray datagrams — an unroutable non-connect datagram is dropped.
   *
   * Mirrors the C# `OnPacket`.
   */
  onPacket(packet: NetRomPacket): void {
    const t = packet.transport;
    const key = localKey(t.circuitIndex, t.circuitId);

    const circuit = this.byLocalKey.get(key);
    if (circuit !== undefined) {
      circuit.onPacket(packet);
      return;
    }

    // No existing circuit. Only a Connect Request creates one; everything else is
    // for a circuit we don't have (a late/duplicate datagram) — drop it, except a
    // Disconnect Request, which we courteously disconnect-ack so the peer stops
    // retransmitting.
    if (t.opcode === NetRomOpcode.ConnectRequest) {
      // Dedup a retransmitted Connect Request (its header names the peer's
      // circuit, so it never matches byLocalKey): if we already minted a circuit
      // for this peer-circuit identity, hand the retransmit to it (it re-acks)
      // rather than minting a duplicate.
      const peerKey = peerKeyFor(packet.network.origin, t.circuitIndex, t.circuitId);
      const existing = this.byPeerKey.get(peerKey);
      if (existing !== undefined) {
        existing.onPacket(packet);
        return;
      }
      this.mintInbound(packet);
    } else if (t.opcode === NetRomOpcode.DisconnectRequest) {
      // Reflect a Disconnect Acknowledge addressed to the peer's circuit (carried
      // in this request's index/id) so a half-open peer settles.
      const network: NetRomNetworkHeader = {
        origin: this._localNode,
        destination: packet.network.origin,
        timeToLive: this.resolvedOptions.timeToLive,
      };
      const transport: NetRomTransportHeader = {
        circuitIndex: t.circuitIndex,
        circuitId: t.circuitId,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.DisconnectAcknowledge,
        flags: NetRomTransportFlags.None,
      };
      this.sendPacket?.({ network, transport, payload: new Uint8Array(0) });
    }
  }

  /**
   * Accept a circuit raised by {@link onIncomingCircuit}: adopt the peer's
   * index/id + proposed window, move it to Connected, and send the Connect
   * Acknowledge.
   *
   * Mirrors the C# static `CircuitManager.AcceptIncoming`.
   */
  static acceptIncoming(e: IncomingCircuitEvent): void {
    e.circuit.acceptInbound(e.peerIndex, e.peerId, e.proposedWindow);
  }

  /**
   * Refuse a circuit raised by {@link onIncomingCircuit}: send a refusing Connect
   * Acknowledge and drop it from the table.
   *
   * Mirrors the C# `RefuseIncoming`.
   */
  refuseIncoming(e: IncomingCircuitEvent): void {
    e.circuit.refuseInbound(e.peerIndex, e.peerId);
    this.deregister(e.circuit);
  }

  /**
   * Advance every circuit's timers by one tick (retransmits + timeouts). Called
   * by the embedder's interval, or by a test after advancing the injected clock.
   *
   * Mirrors the C# `Tick`.
   */
  tick(): void {
    for (const c of [...this.byLocalKey.values()]) {
      c.tick();
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private mintInbound(request: NetRomPacket): void {
    const t = request.transport;
    const remoteNode = request.network.origin;

    // Decode the Connect Request info field:
    // [proposed-window][orig-user][orig-node] (the de-facto NET/ROM layout — see
    // connect-request-info). The proposed window lives in the info field, NOT the
    // transport header (TX/RX are 0 on a connect). Fall back to the origin node
    // for the user, and to "let the circuit default" for the window, if the field
    // is absent/short (a terse peer).
    let originatingUser = remoteNode;
    let proposedWindow = 0;
    const info = tryParseConnectRequestInfo(request.payload);
    if (info !== null) {
      proposedWindow = info.proposedWindow;
      originatingUser = info.originatingUser;
    }

    const peerKey = peerKeyFor(remoteNode, t.circuitIndex, t.circuitId);
    const [index, id] = this.allocateKey();
    const circuit = new NetRomCircuit(
      index,
      id,
      this._localNode,
      remoteNode,
      this.options,
      this.now,
    );
    circuit.sendPacket = (p) => this.sendPacket?.(p);
    this.register(circuit);
    this.byPeerKey.set(peerKey, circuit);
    this.peerKeyOf.set(circuit, peerKey);

    // The peer's own (index,id) live in the Connect Request's index/id fields; its
    // proposed window came from the info field (above).
    const event: IncomingCircuitEvent = {
      circuit,
      remoteNode,
      originatingUser,
      peerIndex: t.circuitIndex,
      peerId: t.circuitId,
      proposedWindow,
    };
    if (this.incomingCircuitListeners.length === 0) {
      // No one is listening — refuse rather than leave a dangling half-open
      // circuit.
      this.refuseIncoming(event);
      return;
    }
    for (const l of [...this.incomingCircuitListeners]) {
      l(event);
    }
  }

  private allocateKey(): [number, number] {
    // Linear probe for a free (index,id). The id advances so a reused index gets
    // a fresh serial (the canonical "circuit id qualifies the index" rule).
    for (let attempt = 0; attempt < 65536; attempt++) {
      const index = this.nextIndex;
      const id = this.nextId;
      this.nextIndex = (this.nextIndex + 1) & 0xff;
      if (this.nextIndex === 0) {
        this.nextId = (this.nextId + 1) & 0xff; // wrapped the index — bump the id serial
      }
      if (!this.byLocalKey.has(localKey(index, id))) {
        return [index, id];
      }
    }
    throw new Error("NET/ROM circuit table exhausted (65536 live circuits).");
  }

  private register(circuit: NetRomCircuit): void {
    this.byLocalKey.set(localKey(circuit.localIndex, circuit.localId), circuit);
    circuit.onClosed(() => this.deregister(circuit));
  }

  private deregister(circuit: NetRomCircuit): void {
    this.byLocalKey.delete(localKey(circuit.localIndex, circuit.localId));
    const peerKey = this.peerKeyOf.get(circuit);
    if (peerKey !== undefined) {
      this.peerKeyOf.delete(circuit);
      this.byPeerKey.delete(peerKey);
    }
  }
}

/** The local-table key for an (index,id) pair. C# uses a value tuple; TS keys the
 *  Map on a string. */
function localKey(index: number, id: number): string {
  return `${index & 0xff}|${id & 0xff}`;
}

/** The peer-table key for an (origin node, index, id) triple. C# uses a value
 *  tuple including the `Callsign` struct; TS keys on the callsign's canonical
 *  string (`Callsign.toString` is base[-ssid], a faithful identity key). */
function peerKeyFor(node: Callsign, index: number, id: number): string {
  return `${node.toString()}|${index & 0xff}|${id & 0xff}`;
}
