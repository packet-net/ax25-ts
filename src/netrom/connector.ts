import { Callsign } from "../callsign.js";
import { PID_NET_ROM } from "../frame.js";
import type { Ax25Listener, Ax25ListenerSession } from "../listener.js";
import type { DataLinkSignal } from "../sdl/action-dispatcher.js";
import { CircuitManager, type IncomingCircuitEvent } from "./circuit-manager.js";
import type { NetRomCircuitOptions } from "./circuit-options.js";
import { NetRomConnection } from "./connection.js";
import { decideForward, ForwardMode, ForwardOutcome } from "./forwarding.js";
import { DEFAULT_TIME_TO_LIVE } from "./network-header.js";
import {
  type NetRomPacket,
  encodeNetRomPacket,
  tryParseNetRomPacket,
} from "./packet.js";
import {
  type NetRomDestination,
  type NetRomRoutingSnapshot,
  NetRomRoutingTable,
  neighbourFor,
  resolveDestination,
} from "./routing-table.js";
import {
  type Inp3Options,
  type ResolvedInp3Options,
  resolveInp3Options,
} from "./inp3-options.js";
import { Inp3Engine } from "./inp3-engine.js";
import { Inp3UpdateScheduler } from "./inp3-update-scheduler.js";
import { Inp3L3RttFrame } from "./inp3-l3rtt.js";
import {
  type Inp3Rif,
  INP3_RIF_SIGNATURE,
  inp3RifToBytes,
  parseInp3Rif,
} from "./inp3-rif.js";
import { SNTT_UNSET } from "./inp3-sntt.js";
import { selectActiveRoute } from "./inp3-route-selector.js";

/** The subset of {@link Ax25Listener} the connector drives: open a CONNECTED-mode
 *  session (the interlink), ship L4 datagrams over it, and learn of an inbound
 *  interlink session (so a circuit a remote opens to us is fed). */
export type NetRomInterlinkListener = Pick<
  Ax25Listener,
  "connect" | "sendData" | "onSessionAccepted"
>;

/** A source of the current learned routing view — the {@link NetRomService}
 *  snapshot, or any object that produces a {@link NetRomRoutingSnapshot}. The
 *  connector reads it (never mutates it) to resolve an alias to its best route. */
export type RoutingSnapshotSource = { snapshot(): NetRomRoutingSnapshot };

/**
 * Construction options for {@link NetRomConnector}. Every field is optional.
 *
 * Mirrors the connect-routing-relevant fields of the C# `NetRomConfig` +
 * `NetRomService` outbound-circuit path.
 */
export interface NetRomConnectorOptions {
  /**
   * Whether NET/ROM L4 connect-routing is enabled (the C# `netRom.connect` opt-in,
   * gated together with `netRom.enabled` in `ConnectEnabled`). Default `false` — a
   * node must opt in to open interlinks + L4 circuits on the air. When `false`,
   * {@link NetRomConnector.connect} resolves no route (returns `null`) so the
   * embedder falls straight back to a direct AX.25 dial.
   */
  enabled?: boolean;
  /**
   * Whether this node **forwards transit datagrams** — relays a NET/ROM L3 datagram
   * whose destination node is not us onward toward its destination (the network-layer
   * routing role; mirrors the C# `netRom.forward`). Default `true`, but effective
   * only when {@link enabled} is on (forwarding needs the connected-mode interlink
   * machinery connect-routing provides). So an endpoint node (`enabled` off) never
   * relays; a connect-enabled node forwards by default; set `false` to run an
   * originate-only node that does not carry third-party traffic.
   */
  forward?: boolean;
  /**
   * How a forwarding node picks among multiple kept routes to a destination
   * ({@link ForwardMode}). Default {@link ForwardMode.PerFlow} — spread distinct L4
   * circuits across the kept routes, quality-weighted, each circuit pinned to one
   * path. Set {@link ForwardMode.BestRoute} for the single best route. Mirrors the C#
   * `netRom.ForwardMode`.
   */
  forwardMode?: ForwardMode;
  /**
   * The L4 circuit tunables ({@link NetRomCircuitOptions}) handed to the owned
   * {@link CircuitManager} — window, retransmit timeout, retries, TTL, fragment
   * size. Defaults to the canonical circuit defaults.
   */
  circuit?: NetRomCircuitOptions;
  /**
   * Injected clock returning epoch ms — the TS analogue of the C# `TimeProvider`.
   * Threaded into the {@link CircuitManager} / every circuit so retransmit timing is
   * deterministic under test. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional sink for faults on the inbound interlink tap / outbound datagram send
   * (a malformed datagram, a transport send failure). Each is wrapped so a single
   * fault can't tear down the pump. Defaults to a no-op.
   */
  onError?: (err: unknown) => void;
  /**
   * The link-down failover seam: called with a neighbour the connector could not
   * raise an interlink to (it did not answer the connect). The embedder wires this
   * to the shared routing table's `markNeighbourDown`, so the dead neighbour's
   * routes leave the table at once and a forward / connect fails over to an
   * alternate next hop — instead of waiting for the obsolescence sweep. Kept as a
   * callback (not a direct table mutation) so the connector stays read-only over
   * the routing view (the focused-objects split). Mirrors the C#
   * `NetRomService.EnsureInterlinkAsync` dial-failure path. Defaults to a no-op.
   */
  onNeighbourDown?: (neighbour: Callsign) => void;
  /**
   * Enable the INP3 time-based routing overlay (the TS analogue of the C#
   * `NetRomService` host-integration). When set, the connector owns an
   * {@link Inp3Engine} + {@link Inp3UpdateScheduler}: it taps inbound PID-0xCF for
   * RIF / L3RTT frames ahead of the L4 path, probes interlink neighbours, ingests
   * RIFs into {@link table} as time-routes, fans out poison-reversed RIFs, and —
   * when `options.preferInp3Routes` is set — forwards / connects over the
   * lowest-target-time route. **Default-off**: omit this and the connector behaves
   * exactly as today (no INP3 frames, no time-routes).
   *
   * `table` MUST be the same writable {@link NetRomRoutingTable} the NODES-ingest
   * side (`NetRomService.routingTable`) writes to, so quality (NODES) and time (RIF)
   * routes coexist on one table — mirroring the single C# table. The engine/scheduler
   * are driven by the connector's {@link tick} (no ambient timer).
   */
  inp3?: {
    /** The shared writable routing table (use `netRomService.routingTable`). */
    readonly table: NetRomRoutingTable;
    /** INP3 tuning (probe cadence, SNTT gain, `preferInp3Routes`, …). */
    readonly options?: Inp3Options;
  };
}

/** Raised by {@link NetRomConnector.connect} when connect-routing is enabled but the
 *  routing table has no route to the target — the signal for the embedder to fall
 *  back to a direct same-port AX.25 dial. Mirrors the C# `NetRomOutboundConnector`
 *  returning to its `fallback` connector on a routing miss. */
export class NetRomNoRouteError extends Error {
  constructor(public readonly target: string) {
    super(`no NET/ROM route to ${target}.`);
    this.name = "NetRomNoRouteError";
  }
}

interface PortAttachment {
  readonly myCall: Callsign;
  readonly listener: NetRomInterlinkListener;
}

interface Interlink {
  readonly portId: string;
  readonly listener: NetRomInterlinkListener;
  readonly session: Ax25ListenerSession;
}

/**
 * The NET/ROM L4 **outbound connector** — the integration seam that turns a
 * `connect <alias>` into an end-to-end network-routed circuit. Given a destination
 * **alias** (e.g. `SOT`) or **callsign** (e.g. `GB7SOT`), it resolves the best route
 * in the routing table, opens a CONNECTED-mode AX.25 **interlink** (PID 0xCF) to the
 * route's best neighbour via the {@link Ax25Listener}, runs a {@link NetRomCircuit}
 * (TS-2) end-to-end over that interlink, and presents the established circuit as a
 * duplex {@link NetRomConnection} the embedder relays the dialling user against —
 * reaching a node the operator has no direct RF path to, by name.
 *
 * **The key integration seam.** The owned {@link CircuitManager}'s `sendPacket` sink
 * is wired to {@link sendNetRomPacket}: a circuit's outbound {@link NetRomPacket} is
 * routed to its L3 destination's best-neighbour interlink and shipped as a PID-0xCF
 * I-frame via {@link Ax25Listener.sendData}. The reverse seam is the interlink tap:
 * every interlink session's inbound PID-0xCF DL-DATA indication is parsed into a
 * {@link NetRomPacket} and fed to {@link CircuitManager.onPacket}. So the circuit
 * layer (which speaks only datagrams, knowing nothing of AX.25) is bridged onto real
 * connected-mode AX.25 sessions in both directions, with the L3 header naming
 * origin = our node, destination = the end node.
 *
 * **Resolution order + fallback.** {@link connect} tries a NET/ROM route first when
 * connect-routing is enabled; on a routing miss it throws {@link NetRomNoRouteError}
 * (it does **not** itself dial a local AX.25 session — that fallback is the embedder's
 * job, keeping the seam clean), mirroring the C# `NetRomOutboundConnector` deferring
 * to its wrapped `fallback` connector.
 *
 * **Host-light, embedder-driven.** The C# `NetRomService` fuses ingest + origination
 * + the L4 connector + interlink management + console-bridge hooks + a `TimeProvider`
 * sweep timer into one node-host type; the TS port keeps the read-only ingest
 * ({@link NetRomService}) and the TX origination ({@link NetRomOriginator}) as
 * separate objects, and this connector is the focused L4 piece — it owns the circuit
 * manager + the interlink map but leaves the routing-table ingest, the NODES
 * origination, and the retransmit-tick cadence to their own owners + the embedder
 * (call {@link tick} from a `setInterval`), consistent with the library's
 * no-ambient-timers design.
 *
 * Mirrors `Packet.Node.Core.NetRom.NetRomOutboundConnector` +
 * `NetRomNodeConnection` + the L4-circuit / interlink portion of `NetRomService`
 * (`ConnectCircuitAsync` / `EnsureInterlinkAsync` / `OnInterlinkData` /
 * `SendNetRomPacket` / `OnIncomingCircuit`) on the C# side.
 */
export class NetRomConnector {
  private readonly enabledFlag: boolean;
  private readonly forwardFlag: boolean;
  private readonly forwardMode: ForwardMode;
  private readonly maxTimeToLive: number;
  private readonly routing: RoutingSnapshotSource;
  private readonly onError: (err: unknown) => void;
  private readonly onNeighbourDown: (neighbour: Callsign) => void;
  private readonly circuits: CircuitManager;

  // Port id -> attachment (the listener whose interlinks we dial + tap).
  private readonly attachments = new Map<string, PortAttachment>();
  // Neighbour callsign string -> the live interlink session we reach it over.
  private readonly interlinks = new Map<string, Interlink>();
  // Sessions whose inbound 0xCF we've already tapped (idempotency — the C# `tapped`
  // set), so dialling AND OnSessionAccepted firing for the same session is harmless.
  private readonly tapped = new WeakSet<Ax25ListenerSession>();

  private nodeCall: Callsign | null = null;
  private disposed = false;

  // ─── INP3 overlay (null unless options.inp3 was supplied) ───
  // The shared writable table (NODES + RIF routes coexist on it), the engine +
  // scheduler, the resolved knobs, and the per-round withdrawn snapshot the
  // advertise sink reads (drained once at the top of each INP3 tick — the atomic
  // round boundary that mirrors the C# host's DrainRecentlyWithdrawn fix).
  private readonly inp3Table: NetRomRoutingTable | null = null;
  private readonly inp3Engine: Inp3Engine | null = null;
  private readonly inp3Scheduler: Inp3UpdateScheduler | null = null;
  private readonly inp3Options: ResolvedInp3Options | null = null;
  private readonly preferInp3: boolean;
  private inp3RoundWithdrawn: readonly Callsign[] = [];

  private readonly incomingListeners: Array<
    (connection: NetRomConnection, event: IncomingCircuitEvent) => void
  > = [];

  /**
   * @param routing The learned-routing view (typically the {@link NetRomService}
   *   whose ingest tap fills the table). Read-only here — the connector resolves an
   *   alias against its snapshot and never mutates it.
   * @param options Connect-routing options. Off by default — set
   *   {@link NetRomConnectorOptions.enabled} to open interlinks + circuits.
   */
  constructor(
    routing: RoutingSnapshotSource,
    options: NetRomConnectorOptions = {},
  ) {
    this.routing = routing;
    this.enabledFlag = options.enabled ?? false;
    this.forwardFlag = options.forward ?? true;
    this.forwardMode = options.forwardMode ?? ForwardMode.PerFlow;
    this.maxTimeToLive = options.circuit?.timeToLive ?? DEFAULT_TIME_TO_LIVE;
    this.onError = options.onError ?? (() => {});
    this.onNeighbourDown = options.onNeighbourDown ?? (() => {});
    this.circuits = new CircuitManager(
      new Callsign("", 0),
      options.circuit,
      options.now ?? Date.now,
    );
    // The key outbound seam: a circuit's datagram is routed to its destination
    // node's best-neighbour interlink and shipped as a PID-0xCF I-frame.
    this.circuits.sendPacket = (p) => this.sendNetRomPacket(p);
    // A remote opening a circuit to us → wrap + raise to the embedder's bridge.
    this.circuits.onIncomingCircuit((e) => this.onIncomingCircuit(e));

    // INP3 overlay (opt-in). When a writable table is supplied, stand up the engine
    // + scheduler and wire their sinks to the interlink send path + the shared table.
    // All dead code when omitted (the inp3* fields stay null → byte-for-byte today).
    if (options.inp3 !== undefined && this.enabledFlag) {
      this.inp3Table = options.inp3.table;
      this.inp3Options = resolveInp3Options(options.inp3.options);
      this.preferInp3 = this.inp3Options.preferInp3Routes;
      const engine = new Inp3Engine(
        new Callsign("", 0),
        options.inp3.options,
        options.now ?? Date.now,
      );
      const scheduler = new Inp3UpdateScheduler(
        options.inp3.options,
        options.now ?? Date.now,
      );
      // L3RTT send: ship the frame over the neighbour's interlink (cold → drop, don't
      // dial — the engine just won't measure an absent link).
      engine.sendL3Rtt = (neighbour, frame) =>
        this.sendInp3Bytes(neighbour, frame.toBytes());
      // 180 s reflection-timeout teardown of an INP3-capable neighbour: drop its
      // routes from the shared table (so forward / connect re-routes at once) AND
      // signal the embedder's failover hook, then refresh the capable fan-out set.
      engine.onNeighbourDown((e) => {
        this.inp3Table?.markNeighbourDown(e.neighbour);
        this.onNeighbourDown(e.neighbour);
        this.refreshInp3Capable();
      });
      // RIF advertise: build the poison-reversed RIF for this neighbour from the
      // round's drained withdrawn snapshot and ship it over the interlink.
      scheduler.advertise = (intent) => {
        if (this.nodeCall === null || this.inp3Table === null) {
          return;
        }
        const rif = this.inp3Table.buildRif(
          this.nodeCall,
          intent.neighbour,
          this.inp3RoundWithdrawn,
        );
        this.sendInp3Bytes(intent.neighbour, inp3RifToBytes(rif));
      };
      this.inp3Engine = engine;
      this.inp3Scheduler = scheduler;
    } else {
      this.preferInp3 = false;
    }
  }

  /** True if NET/ROM L4 connect-routing is enabled. The C# `ConnectEnabled`. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** True if this node forwards transit datagrams (the network-layer routing role).
   *  Rides on {@link enabled} (forwarding needs the interlink machinery) and the
   *  `forward` option (default on). The C# `ForwardEnabled`. */
  get forwardEnabled(): boolean {
    return this.enabledFlag && this.forwardFlag;
  }

  /** The owned circuit table (for surfacing / tests). Mirrors the C#
   * `NetRomService.Circuits`. */
  get circuitManager(): CircuitManager {
    return this.circuits;
  }

  /** Neighbour callsign strings we currently hold a live interlink to (snapshot). */
  get interlinkNeighbours(): readonly string[] {
    return [...this.interlinks.keys()];
  }

  /** The live interlink AX.25 sessions (snapshot), keyed by neighbour callsign
   *  string. A node host disposing gracefully DISCs these (while the listeners are
   *  still alive) so a neighbour isn't left a half-open interlink — the seam the C#
   *  `NetRomService.DisposeAsync` uses. Read-only; the sessions are owned by their
   *  listeners. */
  get interlinkSessions(): ReadonlyMap<string, Ax25ListenerSession> {
    const out = new Map<string, Ax25ListenerSession>();
    for (const [nbr, link] of this.interlinks) {
      out.set(nbr, link.session);
    }
    return out;
  }

  /**
   * Make a port available for interlinks: the connector dials its
   * {@link Ax25Listener.connect} to open an interlink to a neighbour, ships datagrams
   * over the resulting session, and taps the listener's `sessionAccepted` so an
   * *inbound* interlink session (a remote dialling us) is fed into the circuit
   * manager too. The first attached port's `myCall` becomes the node callsign stamped
   * into the L3 origin of circuits we open (the C# `SetLocalNode` at first attach).
   * No-op if connect-routing is disabled, the connector is disposed, or the port is
   * already attached.
   *
   * Mirrors the AX.25-port side of the C# `NetRomService.AttachPort`.
   */
  attachPort(
    portId: string,
    myCall: Callsign | string,
    listener: NetRomInterlinkListener,
  ): void {
    if (!this.enabledFlag || this.disposed || this.attachments.has(portId)) {
      return;
    }
    const call = typeof myCall === "string" ? Callsign.parse(myCall) : myCall;
    this.attachments.set(portId, { myCall: call, listener });

    // Set the node callsign on first attach (circuits minted after carry it).
    if (this.nodeCall === null) {
      this.nodeCall = call;
      this.circuits.setLocalNode(call);
      // The INP3 engine stamps the node into its probes' L3 origin + uses it as the
      // reflection self-test identity — pin it at first attach too.
      this.inp3Engine?.setLocalNode(call);
    }

    // Tap inbound interlinks arriving on this port (a remote dialling us with a
    // PID-0xCF session). Idempotent per session via the `tapped` set.
    listener.onSessionAccepted((session) =>
      this.tapInterlinkSession(portId, listener, session),
    );
  }

  /** Stop offering interlinks on a port. The interlink sessions themselves are owned
   * by the listener; this only forgets the attachment + any interlink running on it.
   * No-op if the port was not attached. */
  detachPort(portId: string): void {
    if (!this.attachments.delete(portId)) {
      return;
    }
    for (const [nbr, link] of [...this.interlinks]) {
      if (link.portId === portId) {
        this.interlinks.delete(nbr);
      }
    }
  }

  /**
   * Subscribe to an *inbound* NET/ROM circuit (a remote opened an L4 circuit to us,
   * routed across the network). The connector auto-accepts the circuit, wraps it as a
   * {@link NetRomConnection}, and hands it to the listener so the embedder can relay
   * the routed user against it (e.g. to a node-console prompt). The data tap is wired
   * before the accept (Connect Acknowledge) is sent, so an inbound frame racing the
   * handshake is not lost.
   *
   * Mirrors the C# `NetRomService.RunInboundConsole` hook + `OnIncomingCircuit`.
   */
  onIncomingConnection(
    listener: (connection: NetRomConnection, event: IncomingCircuitEvent) => void,
  ): void {
    this.incomingListeners.push(listener);
  }

  /**
   * Resolve a `connect <alias>` target and open an L4 circuit to it across the
   * network. The target is an **alias** (e.g. `SOT`) or a **callsign** (e.g. `GB7SOT`,
   * with or without SSID). On a route hit, opens the interlink + circuit and resolves
   * with the established {@link NetRomConnection}; on a routing miss (or when
   * connect-routing is disabled), throws {@link NetRomNoRouteError} so the embedder
   * can fall back to a direct same-port AX.25 dial.
   *
   * @param target The alias or callsign the user typed.
   * @param originatingUser The end user the circuit is on behalf of (carried in the
   *   Connect Request's info field). Defaults to the node callsign.
   *
   * Mirrors the C# `NetRomOutboundConnector.ConnectAsync`.
   */
  async connect(
    target: Callsign | string,
    originatingUser?: Callsign | string,
  ): Promise<NetRomConnection> {
    const targetText =
      typeof target === "string" ? target : target.toString();

    if (this.enabledFlag) {
      const destination = resolveDestination(this.routing.snapshot(), targetText);
      if (destination !== null && destination.bestRoute !== null) {
        const user =
          originatingUser === undefined
            ? (this.nodeCall ?? new Callsign(targetText, 0))
            : typeof originatingUser === "string"
              ? Callsign.parse(originatingUser)
              : originatingUser;
        return this.connectCircuit(destination, user);
      }
    }

    // No NET/ROM route — the embedder falls back to a direct same-port AX.25 dial.
    throw new NetRomNoRouteError(targetText);
  }

  /**
   * Open a NET/ROM L4 circuit to `destination` on behalf of `originatingUser`,
   * routing it via the best neighbour the routing table knows, and await it reaching
   * Connected (or fail). Returns the established circuit wrapped as a
   * {@link NetRomConnection}. Throws if connect-routing is disabled, there is no
   * usable route, the interlink can't be opened, or the circuit is refused / times
   * out. Lower-level entry point behind {@link connect} (which resolves the
   * alias/callsign first); exposed so a caller that already holds the resolved
   * destination can open directly.
   *
   * Mirrors the C# `NetRomService.ConnectCircuitAsync`.
   */
  async connectCircuit(
    destination: NetRomDestination,
    originatingUser: Callsign,
  ): Promise<NetRomConnection> {
    if (this.disposed || this.nodeCall === null) {
      throw new Error("NET/ROM connect-routing is not enabled on this node.");
    }
    const destText = destination.destination.toString();

    // Failover loop: try the best route; if the interlink to its neighbour can't be
    // raised, ensureInterlink has signalled onNeighbourDown — which (via the embedder)
    // drops that neighbour's routes — so re-resolve the destination's now-best route
    // and try again, until one connects or the destination has no routes left. The
    // link-down failover signal at the connect path; mirrors C# ConnectCircuitAsync.
    // Bounded by the dwindling route set (each failure removes a route) with a hard
    // cap as a backstop: 1 + the per-destination route cap (3).
    const cap = 1 + 3;
    for (let attempt = 0; attempt < cap; attempt++) {
      const live = resolveDestination(this.routing.snapshot(), destText);
      const best =
        live === null ? null : selectActiveRoute(live, this.preferInp3);
      if (best === null) {
        throw new Error(`no usable NET/ROM route to ${destText}.`);
      }

      try {
        // Ensure the interlink to the best neighbour is up before originating.
        await this.ensureInterlink(best.neighbour);
      } catch {
        // onNeighbourDown already fired; loop to the next-best route. If that was the
        // last route, the next resolve returns null → the throw above surfaces it.
        continue;
      }

      // Interlink up — originate the L4 circuit and await it reaching connected. A
      // circuit refusal/timeout here is NOT a neighbour-down (the link is fine), so
      // it surfaces rather than failing over — matching C# ConnectCircuitAsync.
      return await this.originateCircuit(destination.destination, originatingUser);
    }

    throw new Error(`no usable NET/ROM route to ${destText} (all next hops are down).`);
  }

  private async originateCircuit(
    destination: Callsign,
    originatingUser: Callsign,
  ): Promise<NetRomConnection> {
    const circuit = this.circuits.openCircuit(destination);
    const connection = new NetRomConnection(circuit, destination);

    // Wire the established / close gate, then drive the connect.
    const established = new Promise<void>((resolve, reject) => {
      circuit.onConnected(() => resolve());
      circuit.onClosed((reason) =>
        reject(
          new Error(
            `NET/ROM circuit to ${destination} ${reason.toLowerCase()}.`,
          ),
        ),
      );
    });
    circuit.connect(originatingUser);

    try {
      await established;
    } catch (err) {
      connection.dispose();
      throw err;
    }
    return connection;
  }

  /**
   * Advance every circuit's retransmit timers by one tick. The embedder drives this
   * from a `setInterval` (or a test calls it after advancing the injected clock),
   * exactly like the {@link CircuitManager.tick} / {@link NetRomOriginator} cadence —
   * the library owns no ambient timers. Mirrors the C# manager's `TimeProvider` tick.
   */
  tick(): void {
    this.circuits.tick();
    // Drive the INP3 engine + scheduler on the same embedder cadence (the C# host
    // uses a 1 s timer; here the embedder's tick is the single driver). No-op off.
    this.inp3Tick();
  }

  /** Forget every port + interlink and stop accepting inbound circuits. The interlink
   * AX.25 sessions are owned by their listeners; a node-host that wants a graceful
   * DISC tears those down via the listener. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.attachments.clear();
    this.interlinks.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  /**
   * Ensure a live interlink (CONNECTED-mode AX.25 session, PID-0xCF) to `neighbour`
   * exists, dialling it if not. Picks the port we last heard the neighbour on (else
   * the first attached port). Taps the resulting session for inbound NET/ROM and
   * records it. Mirrors the C# `EnsureInterlinkAsync`.
   */
  private async ensureInterlink(neighbour: Callsign): Promise<void> {
    const existing = this.interlinks.get(neighbour.toString());
    if (
      existing !== undefined &&
      existing.session.state !== "Disconnected"
    ) {
      return; // already up
    }

    // Dial on the port we last heard the neighbour on (else the first port).
    const nbr = neighbourFor(this.routing.snapshot(), neighbour);
    let portId: string | undefined;
    let attachment: PortAttachment | undefined;
    if (nbr !== null && this.attachments.has(nbr.portId)) {
      portId = nbr.portId;
      attachment = this.attachments.get(nbr.portId);
    } else {
      const first = this.attachments.entries().next().value;
      if (first !== undefined) {
        [portId, attachment] = first;
      }
    }
    if (attachment === undefined || portId === undefined) {
      throw new Error("no NET/ROM port available to open an interlink.");
    }

    // A dial that fails (the neighbour never answered the connect) is the link-down
    // signal: tell the embedder to mark the neighbour down so its now-dead routes
    // leave the table and the caller (forward / connect failover) re-routes. Only
    // the dial is guarded — the pre-dial "no port" throw above is a local-config
    // fault, not a neighbour-down. Mirrors C# EnsureInterlinkAsync.
    let session: Awaited<ReturnType<NetRomInterlinkListener["connect"]>>;
    try {
      session = await attachment.listener.connect(neighbour);
    } catch (err) {
      this.onNeighbourDown(neighbour);
      throw err;
    }
    // Tap the session for inbound NET/ROM (idempotent — the tap guards itself, so
    // sessionAccepted firing for this dial too is harmless), then record it.
    this.tapInterlinkSession(portId, attachment.listener, session);
    this.interlinks.set(neighbour.toString(), {
      portId,
      listener: attachment.listener,
      session,
    });
  }

  /**
   * Attach the NET/ROM inbound tap to an interlink session exactly once. The tap
   * feeds PID-0xCF DL-DATA indications into the circuit manager; a node-console
   * session over the same port ignores 0xCF, so the two coexist. The session is
   * recorded as an interlink only when it actually carries NET/ROM (on the first
   * 0xCF datagram), so a plain console session is never mistaken for one. On the
   * session's disconnect, the tap + interlink entry are dropped.
   *
   * Mirrors the C# `NetRomService.OnSessionAccepted`.
   */
  private tapInterlinkSession(
    portId: string,
    listener: NetRomInterlinkListener,
    session: Ax25ListenerSession,
  ): void {
    if (this.disposed || this.tapped.has(session)) {
      return;
    }
    this.tapped.add(session);
    const peerKey = session.to.toString();

    session.onDataLinkSignal((sig: DataLinkSignal) => {
      if (sig.type === "DL_DATA_indication" && sig.pid === PID_NET_ROM) {
        // First 0xCF data → this is an interlink; remember the session so our
        // outbound datagrams to this neighbour reuse it.
        if (!this.interlinks.has(peerKey)) {
          this.interlinks.set(peerKey, { portId, listener, session });
        }
        this.onInterlinkData(session, sig.data);
      } else if (
        sig.type === "DL_DISCONNECT_indication" ||
        sig.type === "DL_DISCONNECT_confirm"
      ) {
        const link = this.interlinks.get(peerKey);
        if (link !== undefined && link.session === session) {
          this.interlinks.delete(peerKey);
        }
      }
    });
  }

  /**
   * Parse an inbound interlink I-frame's info field into a {@link NetRomPacket} and
   * feed it to the circuit manager (which demuxes it to the right circuit, or mints
   * an inbound circuit for a Connect Request). A malformed datagram is dropped.
   * Mirrors the C# `OnInterlinkData`.
   */
  private onInterlinkData(
    session: Ax25ListenerSession,
    info: Uint8Array,
  ): void {
    try {
      // INP3 peel (mirrors the C# `DispatchInp3`, the load-bearing precedence): when
      // the overlay is on, a RIF (0xFF-led) or an L3RTT is consumed BEFORE the L4
      // path so it can never reach circuits / forwarding. Returns true when consumed.
      if (this.inp3Engine !== null && this.dispatchInp3(session.to, info)) {
        return;
      }
      const packet = tryParseNetRomPacket(info);
      if (packet === null) {
        return;
      }
      // L3 dispatch (mirrors the C# `NetRomService.OnInterlinkData`): a datagram
      // addressed to this node terminates here (up to the L4 circuit layer); one
      // addressed to another node is forwarded toward its destination (the
      // network-layer routing role); an endpoint-only node drops it.
      if (this.nodeCall !== null && packet.network.destination.equals(this.nodeCall)) {
        this.circuits.onPacket(packet);
      } else if (this.forwardEnabled) {
        this.forwardDatagram(packet, session.to);
      }
    } catch (err) {
      void session;
      this.onError(err);
    }
  }

  // ─── INP3 overlay internals (no-ops unless the overlay was constructed) ───

  /**
   * Peel a RIF / L3RTT off the inbound 0xCF stream before the L4 path (mirrors the
   * C# `DispatchInp3`). Precedence: (A) a 0xFF-led frame is a RIF — consumed whether
   * or not it parses (a malformed RIF is dropped, never retried as L4); (B) an L3RTT
   * to `L3RTT-0` is timed/reflected by the engine and consumed. Anything else is not
   * INP3 → returns false so the caller runs the existing L4 dispatch. Observing the
   * neighbour here makes every 0xCF-speaking peer a probe target (optimistic probing).
   */
  private dispatchInp3(fromNeighbour: Callsign, info: Uint8Array): boolean {
    const engine = this.inp3Engine;
    if (engine === null) {
      return false;
    }
    engine.observeNeighbour(fromNeighbour);

    // (A) RIF? — the single-byte 0xFF signature is a total, unambiguous discriminator
    // (a 0xFF first byte can't be a valid AX.25-shifted callsign).
    if (info.length >= 1 && info[0] === INP3_RIF_SIGNATURE) {
      const rif = parseInp3Rif(info);
      if (rif !== null) {
        this.ingestInp3Rif(fromNeighbour, rif);
      }
      return true; // consumed either way (malformed 0xFF-led frame dropped, never L4).
    }

    // (B) L3RTT? — a well-formed NetRomPacket to L3RTT-0.
    const packet = tryParseNetRomPacket(info);
    if (packet !== null && Inp3L3RttFrame.isL3Rtt(packet)) {
      engine.onL3Rtt(fromNeighbour, packet); // times our reflection, or reflects a peer probe
      return true;
    }
    return false; // not INP3 — fall through to the L4 path.
  }

  /**
   * Ingest a parsed RIF into the shared table as time-routes, supplying the engine's
   * measured SNTT for the carrying link. Any destination that loses its last INP3
   * route lands in the table's recently-withdrawn set; it is NOT escalated here — the
   * next {@link tick} drains the set atomically and fans it out, so this pump path
   * never races the fan-out round (the C# host-thread race fix).
   */
  private ingestInp3Rif(from: Callsign, rif: Inp3Rif): void {
    if (
      this.nodeCall === null ||
      this.inp3Table === null ||
      this.inp3Engine === null ||
      this.inp3Options === null
    ) {
      return;
    }
    const sntt = this.inp3Engine.snttMs(from) ?? SNTT_UNSET;
    this.inp3Table.ingestRif(
      from,
      this.nodeCall,
      sntt,
      rif,
      this.inp3Options.hopLimit,
    );
  }

  /** Send raw INP3 bytes (an L3RTT or a RIF) over a neighbour's interlink if one is
   *  up. Cold-interlink: drop, don't dial (the engine simply won't measure/advertise
   *  over an absent link) — mirrors the C# `TrySendOverInterlinkBytes`. */
  private sendInp3Bytes(neighbour: Callsign, bytes: Uint8Array): void {
    const link = this.interlinks.get(neighbour.toString());
    if (link !== undefined) {
      link.listener.sendData(link.session, bytes, PID_NET_ROM);
    }
  }

  /** Reconcile the scheduler's fan-out target set from the engine's INP3-capable
   *  neighbours (the C# `RefreshCapableNeighbours`). */
  private refreshInp3Capable(): void {
    if (this.inp3Engine === null || this.inp3Scheduler === null) {
      return;
    }
    const capable = this.inp3Engine.neighbours
      .filter((n) => n.inp3Capable)
      .map((n) => n.neighbour);
    this.inp3Scheduler.setTargetNeighbours(capable);
  }

  /**
   * One INP3 host tick, in the locked order (mirrors the C# `Inp3Host.TickOnce`):
   * refresh the capable set → tick the engine (probes / 180 s resets) → DRAIN the
   * recently-withdrawn set once (the atomic round boundary), mark each NEGATIVE so
   * the round fans out immediately, hand the same snapshot to every `buildRif` via
   * {@link inp3RoundWithdrawn} → tick the scheduler (fans out due intents). Draining
   * once at the round start (rather than reading the live set per-neighbour) closes
   * the host-thread race: a concurrent ingest landing mid-round is captured by the
   * NEXT drain, never cleared unadvertised.
   */
  private inp3Tick(): void {
    const engine = this.inp3Engine;
    const scheduler = this.inp3Scheduler;
    const table = this.inp3Table;
    if (engine === null || scheduler === null || table === null) {
      return;
    }
    try {
      this.refreshInp3Capable();
      engine.tick(); // may withdraw routes via onNeighbourDown → recentlyWithdrawn
      const withdrawn = table.drainRecentlyWithdrawn();
      for (const dest of withdrawn) {
        scheduler.markWithdrawn(dest);
      }
      this.inp3RoundWithdrawn = withdrawn;
      try {
        scheduler.tick();
      } finally {
        this.inp3RoundWithdrawn = [];
      }
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * Forward a transit datagram (one whose destination node is not us) one hop toward
   * its destination. The decision (TTL decrement/cap, loop guard, no-bounce-back
   * next-hop resolution) is the pure {@link decideForward}, mirroring the C#
   * `NetRomService.ForwardDatagram`; this method does only the I/O — send over the
   * next-hop interlink if it is up (in order), else dial it first then send.
   */
  private forwardDatagram(packet: NetRomPacket, receivedFrom: Callsign): void {
    if (this.nodeCall === null) {
      return;
    }
    const decision = decideForward(
      packet,
      receivedFrom,
      this.nodeCall,
      this.routing.snapshot(),
      this.maxTimeToLive,
      this.forwardMode,
      this.preferInp3,
    );
    if (decision.outcome !== ForwardOutcome.ForwardTo || decision.nextHop === null) {
      // Dropped — TTL expired, looped back to origin, or no onward route.
      return;
    }

    const neighbour = decision.nextHop;
    const neighbourKey = neighbour.toString();
    const bytes = encodeNetRomPacket(decision.packet);

    const link = this.interlinks.get(neighbourKey);
    if (link !== undefined) {
      link.listener.sendData(link.session, bytes, PID_NET_ROM);
      return;
    }

    // No interlink yet — establish it, then send (a transit cold-start).
    void this.ensureInterlink(neighbour)
      .then(() => {
        const established = this.interlinks.get(neighbourKey);
        if (established !== undefined) {
          established.listener.sendData(established.session, bytes, PID_NET_ROM);
        }
      })
      .catch((err) => this.onError(err));
  }

  /**
   * The circuit manager's `sendPacket` sink — the **key outbound seam**: route a
   * datagram to its L3 destination node's best neighbour over that neighbour's
   * interlink, shipped as a PID-0xCF I-frame.
   *
   * Next-hop order (mirroring the C# `SendNetRomPacket`): (1) a direct interlink to
   * the destination node itself — covers replying to a peer over the very session
   * its datagram arrived on, even one that never broadcast NODES; (2) the best route
   * in the routing table; (3) the destination as a directly-heard neighbour. A
   * datagram with no resolvable next hop, or whose interlink isn't up, is dropped
   * (logged via {@link NetRomConnectorOptions.onError}) — the
   * {@link ensureInterlink} path establishes the link before the first outbound
   * datagram, so a missing link here is a transit/edge case, not the common path.
   */
  private sendNetRomPacket(packet: NetRomPacket): void {
    try {
      const dest = packet.network.destination;
      const destKey = dest.toString();

      let neighbourKey: string | null = null;
      if (this.interlinks.has(destKey)) {
        neighbourKey = destKey;
      } else {
        const snap = this.routing.snapshot();
        const resolved = resolveDestination(snap, destKey);
        const active =
          resolved === null ? null : selectActiveRoute(resolved, this.preferInp3);
        if (active !== null) {
          neighbourKey = active.neighbour.toString();
        } else if (neighbourFor(snap, dest) !== null) {
          neighbourKey = destKey;
        }
      }

      if (neighbourKey === null) {
        this.onError(new Error(`NET/ROM: no route to ${destKey} for outbound datagram.`));
        return;
      }

      const link = this.interlinks.get(neighbourKey);
      if (link === undefined) {
        // No interlink yet — ensureInterlink establishes it before the first
        // datagram on the outbound path, so a missing link here is a transit edge.
        this.onError(new Error(`NET/ROM: no interlink to ${neighbourKey} for outbound datagram.`));
        return;
      }

      link.listener.sendData(link.session, encodeNetRomPacket(packet), PID_NET_ROM);
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * A remote opened a circuit to us. Auto-accept it (the C# no-console-hook path
   * always accepts; with a console bridge it accepts after wiring the data tap), wrap
   * it as a {@link NetRomConnection}, and raise it to every
   * {@link onIncomingConnection} subscriber. The connection subscribes the circuit's
   * data event in its constructor, so wiring it before the accept means no inbound
   * Info racing the connect-ack is lost (the C# ordering).
   *
   * Mirrors the C# `NetRomService.OnIncomingCircuit`.
   */
  private onIncomingCircuit(event: IncomingCircuitEvent): void {
    const connection = new NetRomConnection(event.circuit, event.remoteNode);
    CircuitManager.acceptIncoming(event);
    for (const l of [...this.incomingListeners]) {
      try {
        l(connection, event);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
