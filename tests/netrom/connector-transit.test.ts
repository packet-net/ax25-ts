import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NetRomCircuitState,
  NetRomConnector,
  NetRomRoutingTable,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { Ax25Listener } from "../../src/listener.js";
import { waitFor } from "../listener-test-support.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";
import { MockTransport, pair } from "../mock-transport.js";
import { ascii, asciiStr } from "./connect-harness.js";

/**
 * Integration-level NET/ROM **transit forwarding** over real `Ax25Listener`s —
 * mirroring the C# `NetRomL3L4IntegrationTests.A_transit_node_forwards...` test. A
 * line topology A — B — C: node A on channel 1, node C on channel 2, node B
 * bridging both. A can reach C only *via B*; a `connect <alias>` from A originates an
 * L4 circuit whose datagrams B forwards across the channel bridge both ways, C
 * accepts + echoes, data round-trips, and B holds NO circuit (it only forwarded).
 * This is the thing a leaf node cannot do.
 */
const A_NODE = new Callsign("GB7AAA", 0);
const B_NODE = new Callsign("GB7BBB", 0);
const C_NODE = new Callsign("GB7CCC", 0);
const USER = new Callsign("M0LTE", 7);
const BUDGET = 20_000;

interface Node {
  readonly call: Callsign;
  readonly connector: NetRomConnector;
  readonly table: NetRomRoutingTable;
  readonly listeners: Ax25Listener[];
}

function seedRoute(table: NetRomRoutingTable, originator: Callsign, myCall: Callsign, portId: string, entry: NodesEntrySpec): void {
  const bc = parseNodesBroadcast(buildNodesInfo("X", [entry]));
  table.ingest(originator, myCall, portId, bc!);
}

/** Make `table` learn `originator` as a directly-heard neighbour on `portId` (a
 *  header-only NODES broadcast — no entries). */
function seedNeighbour(table: NetRomRoutingTable, originator: Callsign, myCall: Callsign, portId: string): void {
  const bc = parseNodesBroadcast(buildNodesInfo("X", []));
  table.ingest(originator, myCall, portId, bc!);
}

function buildNode(call: Callsign, ports: Array<{ portId: string; transport: MockTransport }>): Node {
  const table = new NetRomRoutingTable();
  const connector = new NetRomConnector({ snapshot: () => table.snapshot() }, { enabled: true });
  const listeners = ports.map((p) => {
    const listener = new Ax25Listener(p.transport, { myCall: call });
    connector.attachPort(p.portId, call, listener);
    return listener;
  });
  return { call, connector, table, listeners };
}

async function disposeNode(node: Node): Promise<void> {
  for (const s of node.connector.interlinkSessions.values()) {
    await s.disconnect().catch(() => {});
  }
  node.connector.dispose();
  for (const l of node.listeners) {
    await l.dispose();
  }
}

describe("NetRomConnector — 3-node transit forwarding (integration)", () => {
  it("forwards an L4 circuit between two channels it bridges, without terminating it", async () => {
    const link1 = pair(); // A ↔ B (channel 1)
    const link2 = pair(); // B ↔ C (channel 2)

    const a = buildNode(A_NODE, [{ portId: "p1", transport: link1.a }]);
    const b = buildNode(B_NODE, [
      { portId: "p1", transport: link1.b },
      { portId: "p2", transport: link2.a },
    ]);
    const c = buildNode(C_NODE, [{ portId: "p1", transport: link2.b }]);

    // Routing (seeded the way ingest would learn it): A reaches C via B; C reaches A
    // via B; B knows A on p1 and C on p2 directly.
    seedRoute(a.table, B_NODE, A_NODE, "p1", { dest: C_NODE, destAlias: "CCC", neighbour: C_NODE, quality: 200 });
    seedRoute(c.table, B_NODE, C_NODE, "p1", { dest: A_NODE, destAlias: "AAA", neighbour: A_NODE, quality: 200 });
    seedNeighbour(b.table, A_NODE, B_NODE, "p1");
    seedNeighbour(b.table, C_NODE, B_NODE, "p2");

    // C is the endpoint: echo a banner on connect, `ack:<line>` on each line.
    const echoed: unknown[] = [];
    c.connector.onIncomingConnection((conn) => {
      echoed.push(conn);
      conn.onData((chunk) => conn.write(ascii("ack:" + asciiStr(chunk))));
      conn.write(ascii("c-prompt\r"));
    });

    await Promise.all([...a.listeners, ...b.listeners, ...c.listeners].map((l) => l.start()));

    try {
      const received: Uint8Array[] = [];
      const connection = await a.connector.connect("CCC", USER);
      connection.onData((chunk) => received.push(chunk));

      // The L4 circuit is up end-to-end, transiting B.
      expect(connection.circuit.state).toBe(NetRomCircuitState.Connected);
      expect(connection.peerId).toBe(C_NODE.toString());
      await waitFor(
        () => c.connector.circuitManager.circuits.some((x) => x.state === NetRomCircuitState.Connected),
        BUDGET,
        "node C should hold the accepted circuit",
      );
      expect(echoed.length).toBe(1);

      // The headline: B forwarded the circuit's datagrams between its two channels
      // and holds NO circuit of its own.
      expect(b.connector.circuitManager.circuits.length).toBe(0);

      // C's banner reached A through B (the C→B→A forwarding path).
      await waitFor(() => received.some((r) => asciiStr(r).includes("c-prompt")), BUDGET, "C's banner should reach A via B");

      // A→C→A round-trip through the transit node.
      connection.write(ascii("hi-transit\r"));
      await waitFor(
        () => received.some((r) => asciiStr(r).includes("ack:hi-transit")),
        BUDGET,
        "the line A sent transits to C and the ack relays back through B",
      );
      expect(b.connector.circuitManager.circuits.length).toBe(0);
    } finally {
      await disposeNode(a);
      await disposeNode(b);
      await disposeNode(c);
    }
  });
});
