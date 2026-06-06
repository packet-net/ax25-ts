/**
 * A two-node, in-memory NET/ROM `connect <alias>` harness — the integration-slice
 * analogue of the C# `NetRomL3L4IntegrationTests` two-node test, but built from the
 * library's real objects over an in-process AX.25 channel rather than the node-host
 * `PortSupervisor` + software-RF bus.
 *
 * Two real {@link Ax25Listener}s — node A (`GB7AAA`) and node B (`GB7BBB`) — are
 * cross-connected over a {@link MockTransport} pair (bytes A sends arrive at B and
 * vice-versa, the in-memory stand-in for the RF interlink that carries PID-0xCF
 * I-frames). Each node runs a real {@link NetRomConnector} over a
 * {@link NetRomRoutingTable} seeded the way real ingest would learn it (via
 * {@link NetRomRoutingTable.ingest} of a synthetic NODES broadcast — the same code
 * path the {@link NetRomService} tap drives). Node B's connector auto-accepts inbound
 * circuits and bridges each to a tiny echo console, so a `connect <alias>` from A
 * reaches a far prompt that talks back — the end-to-end L4 round-trip.
 *
 * The harness is deliberately thin: it builds the two listeners + connectors + tables
 * and exposes them, leaving the assertions to the test. The AX.25 listeners pump
 * inbound frames on microtasks (the {@link MockTransport} delivers via
 * `queueMicrotask`), so the harness is real-time-async like the C# node-host test —
 * tests `await` the connector promises + a small {@link waitFor} budget rather than a
 * deterministic fake clock (the deterministic-clock L4 path is TS-2's
 * {@link CircuitPairHarness}).
 */
import { Callsign } from "../../src/callsign.js";
import { Ax25Listener } from "../../src/listener.js";
import {
  type NetRomConnection,
  NetRomConnector,
  type NetRomConnectorOptions,
  NetRomRoutingTable,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { MockTransport, pair } from "../mock-transport.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";

/**
 * Node callsigns. This 2-node harness exercises `connect <alias>` to the node
 * reached over the interlink — node B itself. (Before L3 forwarding, the tests used
 * a fictional distinct `END` node that B silently terminated on behalf of; that only
 * worked because the node terminated *every* inbound circuit regardless of L3
 * destination. With forwarding, a node terminates only circuits addressed to itself,
 * so the endpoint here is B — the real interlink peer. Genuine multi-hop transit
 * forwarding is covered by the deterministic `decideForward` tests + the C# 3-node
 * transit integration test.)
 */
export const A_NODE = new Callsign("GB7AAA", 0);
export const B_NODE = new Callsign("GB7BBB", 0);
export const END_NODE = B_NODE;
export const END_ALIAS = "BNODE";
export const PORT_ID = "p1";

/** Encode a string as ASCII bytes (the TS analogue of `Encoding.ASCII.GetBytes`). */
export function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

/** Decode ASCII bytes back to a string. */
export function asciiStr(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

/** One node end of the harness: its listener, connector, routing table + transport. */
export interface HarnessNode {
  readonly call: Callsign;
  readonly listener: Ax25Listener;
  readonly connector: NetRomConnector;
  readonly table: NetRomRoutingTable;
  readonly transport: MockTransport;
}

/**
 * The two-node NET/ROM connect harness. Build with {@link create}, drive
 * {@link NetRomConnector.connect} on {@link a}, assert, then {@link dispose}.
 */
export class ConnectHarness {
  private constructor(
    readonly a: HarnessNode,
    readonly b: HarnessNode,
  ) {}

  /**
   * Stand up the two nodes. Both connectors have connect-routing enabled and are
   * attached to their listener's port; node A's table is seeded with a route to
   * {@link END_NODE} via neighbour {@link B_NODE} (so `connect <ENDND>` resolves to a
   * best-neighbour interlink to B). Node B auto-accepts inbound circuits — wire its
   * console via the returned node's connector `onIncomingConnection` before
   * connecting from A.
   *
   * @param options Per-connector overrides (e.g. a fast retransmit clock) applied to
   *   both nodes.
   */
  static async create(options?: NetRomConnectorOptions): Promise<ConnectHarness> {
    const link = pair();

    const a = ConnectHarness.buildNode(A_NODE, link.a, options);
    const b = ConnectHarness.buildNode(B_NODE, link.b, options);

    // Seed node A's routing table the way real ingest would: A heard a NODES
    // broadcast from neighbour B (`GB7BBB`) on port p1 advertising the end node
    // `GB7END` (alias ENDND). The originator of a broadcast is always the via-
    // neighbour, so this yields a route to END_NODE via B_NODE — exactly what
    // `connect <ENDND>` resolves to its best next hop.
    ConnectHarness.seedRoute(a, B_NODE, "BNODE", {
      dest: END_NODE,
      destAlias: END_ALIAS,
      neighbour: END_NODE,
      quality: 200,
    });

    await a.listener.start();
    await b.listener.start();

    return new ConnectHarness(a, b);
  }

  /**
   * Bridge every inbound circuit node B accepts to an echo console: it sends a banner
   * on connect and replies `ack:<line>` to each received line. Returns a list that
   * fills with the bridged connections (for assertions). Mirrors the C# test's
   * `RunInboundConsole` echo bridge.
   */
  echoConsoleOnB(banner = "bnode-prompt\r"): NetRomConnection[] {
    const connections: NetRomConnection[] = [];
    this.b.connector.onIncomingConnection((conn) => {
      connections.push(conn);
      conn.onData((chunk) => {
        conn.write(ascii("ack:" + asciiStr(chunk)));
      });
      conn.write(ascii(banner));
    });
    return connections;
  }

  /** Tear both nodes down. Gracefully DISC the interlink AX.25 sessions first (while
   *  the listeners are still alive) so a lingering T1 retransmit can't fire a send
   *  onto a stopped transport, then dispose the listeners — mirroring the C#
   *  `NetRomService.DisposeAsync` discipline (DISC interlinks before the listener
   *  tears down). */
  async dispose(): Promise<void> {
    // DISC the interlinks while the connectors still hold them (dispose() clears the
    // interlink map) and the listeners are still alive.
    await this.discInterlinks(this.a);
    await this.discInterlinks(this.b);
    this.a.connector.dispose();
    this.b.connector.dispose();
    await this.a.listener.dispose();
    await this.b.listener.dispose();
  }

  private async discInterlinks(node: HarnessNode): Promise<void> {
    const sessions = [...node.connector.interlinkSessions.values()];
    await Promise.all(
      sessions.map((s) => s.disconnect().catch(() => {})),
    );
  }

  // ─── Internals ────────────────────────────────────────────────────

  private static buildNode(
    call: Callsign,
    transport: MockTransport,
    options?: NetRomConnectorOptions,
  ): HarnessNode {
    const listener = new Ax25Listener(transport, { myCall: call });
    const table = new NetRomRoutingTable();
    const connector = new NetRomConnector(
      { snapshot: () => table.snapshot() },
      { enabled: true, ...options },
    );
    connector.attachPort(PORT_ID, call, listener);
    return { call, listener, connector, table, transport };
  }

  private static seedRoute(
    node: HarnessNode,
    neighbour: Callsign,
    neighbourAlias: string,
    entry: NodesEntrySpec,
  ): void {
    const info = buildNodesInfo(neighbourAlias, [entry]);
    const broadcast = parseNodesBroadcast(info);
    if (broadcast === null) {
      throw new Error("harness seed: synthetic NODES broadcast failed to parse");
    }
    node.table.ingest(neighbour, node.call, PORT_ID, broadcast);
  }
}
