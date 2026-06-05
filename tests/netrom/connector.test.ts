/**
 * TS-4 — the NET/ROM `connect <alias>` outbound-routing integration slice.
 *
 * The unit mirror of the C# `NetRomL3L4IntegrationTests.Two_nodes_exchange_NODES_
 * and_a_user_routes_across_an_L4_circuit_to_the_distant_node` (+ the unknown-alias
 * case): a two-node in-memory harness where node A `connect`s by **alias** to an end
 * node reachable via neighbour B, asserting the AX.25 interlink session opens to B,
 * the {@link NetRomCircuit} reaches Connected, data round-trips end-to-end over the
 * circuit, and a disconnect tears down both the circuit and the interlink. Built from
 * the library's real objects (two {@link Ax25Listener}s cross-connected over a
 * {@link MockTransport} pair, a real {@link NetRomConnector} per node) — the closest
 * unit-level analogue of the C# node-host two-node test.
 */
import { describe, expect, it } from "vitest";
import {
  NetRomCircuitState,
  type NetRomConnection,
  NetRomConnector,
  NetRomNoRouteError,
  NetRomRoutingTable,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { waitFor } from "../listener-test-support.js";
import { buildNodesInfo } from "../netrom-builder.js";
import {
  ascii,
  asciiStr,
  A_NODE,
  B_NODE,
  ConnectHarness,
  END_ALIAS,
  END_NODE,
} from "./connect-harness.js";

const BUDGET = 2000;

describe("NetRomConnector — connect <alias> outbound routing (TS-4)", () => {
  it("routes connect <alias> across an L4 circuit to the distant node, round-trips data, and tears down both layers", async () => {
    const harness = await ConnectHarness.create({ enabled: true });
    const echoed = harness.echoConsoleOnB("bnode-prompt\r");

    try {
      // The headline: node A dials the END node by its ALIAS (ENDND). A resolves it
      // in the routing table → best route is via neighbour B → A opens a CONNECTED
      // AX.25 interlink to B (PID-0xCF), originates an L4 circuit to END over it, and
      // gets back a duplex connection.
      const received: Uint8Array[] = [];
      const connection = await harness.a.connector.connect(END_ALIAS, "M0LTE-7");
      connection.onData((chunk) => received.push(chunk));

      // 1. The interlink AX.25 session to B is up (A dialled GB7BBB, the best
      //    neighbour — NOT the END node, which A has no direct RF path to).
      expect(harness.a.connector.interlinkNeighbours).toContain(B_NODE.toString());

      // 2. The L4 circuit reached Connected on both ends.
      expect(connection.circuit.state).toBe(NetRomCircuitState.Connected);
      expect(connection.peerId).toBe(END_NODE.toString());
      expect(harness.a.connector.circuitManager.circuits.length).toBe(1);
      await waitFor(
        () =>
          harness.b.connector.circuitManager.circuits.some(
            (c) => c.state === NetRomCircuitState.Connected,
          ),
        BUDGET,
        "node B should hold the accepted circuit",
      );

      // The L3 header names origin = our node (A), destination = the END node.
      const aCircuit = harness.a.connector.circuitManager.circuits[0]!;
      expect(aCircuit.remoteNode.equals(END_NODE)).toBe(true);

      // 3. B's echo console sent its banner over the circuit — Information flows B→A.
      await waitFor(() => received.length > 0, BUDGET, "B's banner should arrive");
      expect(asciiStr(received[0]!)).toContain("bnode-prompt");

      // 4. Data round-trips end-to-end: A writes a line, B's console echoes ack:<line>.
      connection.write(ascii("hello-over-circuit\r"));
      await waitFor(
        () => received.some((r) => asciiStr(r).includes("ack:hello-over-circuit")),
        BUDGET,
        "the line A sent over the circuit reaches B's console and the ack relays back",
      );
      expect(echoed.length).toBe(1); // B bridged exactly one inbound circuit

      // 5. Disconnect tears down BOTH the circuit and the interlink path. dispose()
      //    drives a NET/ROM Disconnect Request and settles the connection; the circuit
      //    reaches Disconnected once the Disconnect Acknowledge round-trips over the
      //    interlink. The manager deregisters a closed circuit, so both tables empty.
      const aClosed = new Promise<void>((resolve) => connection.onClosed(resolve));
      connection.dispose();
      await aClosed;
      expect(connection.closed).toBe(true);
      await waitFor(
        () =>
          harness.a.connector.circuitManager.circuits.length === 0 &&
          harness.b.connector.circuitManager.circuits.every(
            (c) => c.state === NetRomCircuitState.Disconnected,
          ),
        BUDGET,
        "the disconnect tears down the circuit on both ends",
      );
      expect(connection.circuit.state).toBe(NetRomCircuitState.Disconnected);
    } finally {
      await harness.dispose();
    }
  });

  it("opens the interlink to the best neighbour exactly once and reuses it for a second circuit", async () => {
    // Two circuits to the same end node share the one interlink to B (the C#
    // EnsureInterlinkAsync 'already up' branch).
    const harness = await ConnectHarness.create({ enabled: true });
    harness.echoConsoleOnB();
    try {
      const c1 = await harness.a.connector.connect(END_ALIAS);
      const neighboursAfterFirst = [...harness.a.connector.interlinkNeighbours];
      const c2 = await harness.a.connector.connect(END_ALIAS);

      expect(c1.circuit.state).toBe(NetRomCircuitState.Connected);
      expect(c2.circuit.state).toBe(NetRomCircuitState.Connected);
      // Still exactly one interlink neighbour (B) — the second connect reused it.
      expect(neighboursAfterFirst).toEqual([B_NODE.toString()]);
      expect(harness.a.connector.interlinkNeighbours).toEqual([B_NODE.toString()]);
      // Two distinct circuits on A.
      expect(harness.a.connector.circuitManager.circuits.length).toBe(2);
      expect(c1.circuit).not.toBe(c2.circuit);
    } finally {
      await harness.dispose();
    }
  });

  it("resolves connect by the destination CALLSIGN as well as its alias", async () => {
    const harness = await ConnectHarness.create({ enabled: true });
    harness.echoConsoleOnB();
    try {
      // Dial by callsign text (GB7END), not the alias — the resolver's callsign
      // fallback (the C# ResolveDestination callsign branch).
      const connection = await harness.a.connector.connect(END_NODE.toString());
      expect(connection.circuit.state).toBe(NetRomCircuitState.Connected);
      expect(connection.peerId).toBe(END_NODE.toString());
    } finally {
      await harness.dispose();
    }
  });

  it("surfaces a no-route connect cleanly so the embedder can fall back", async () => {
    const harness = await ConnectHarness.create({ enabled: true });
    try {
      // Node A has no route to NOWHER — connect must surface NetRomNoRouteError (the
      // signal for the embedder's direct-AX.25 fallback), not open anything.
      await expect(harness.a.connector.connect("NOWHER")).rejects.toBeInstanceOf(
        NetRomNoRouteError,
      );
      // No interlink opened, no circuit minted.
      expect(harness.a.connector.interlinkNeighbours.length).toBe(0);
      expect(harness.a.connector.circuitManager.circuits.length).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("treats connect as a no-route miss when connect-routing is disabled", async () => {
    // enabled=false → connect short-circuits to a no-route miss even though a route
    // exists in the table, so a disabled node falls straight back to a local dial
    // (the C# ConnectEnabled gate). A seeded routing view + a disabled connector is
    // all this needs — no listener/port is touched on the disabled path.
    const table = seededTableA();
    const connector = new NetRomConnector(
      { snapshot: () => table.snapshot() },
      { enabled: false },
    );
    expect(connector.enabled).toBe(false);
    await expect(connector.connect(END_ALIAS)).rejects.toBeInstanceOf(
      NetRomNoRouteError,
    );
    expect(connector.interlinkNeighbours.length).toBe(0);
    connector.dispose();
  });

  it("the no-route error names the target", () => {
    const err = new NetRomNoRouteError("GB7XYZ");
    expect(err.target).toBe("GB7XYZ");
    expect(err.message).toContain("GB7XYZ");
    expect(err.name).toBe("NetRomNoRouteError");
  });

  it("the connection wraps the circuit as a duplex stream (peerId, completion, closed)", async () => {
    const harness = await ConnectHarness.create({ enabled: true });
    harness.echoConsoleOnB();
    try {
      const connection: NetRomConnection = await harness.a.connector.connect(END_ALIAS);
      expect(connection.closed).toBe(false);

      // completion resolves on close.
      const done = connection.completion;
      let settled = false;
      void done.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);

      connection.dispose();
      await done;
      expect(settled).toBe(true);
      expect(connection.closed).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});

/** A routing table seeded with node A's route (END_NODE via neighbour B_NODE), the
 *  same seed the two-node harness gives node A. Used by the disabled-gate test. */
function seededTableA(): NetRomRoutingTable {
  const table = new NetRomRoutingTable();
  const broadcast = parseNodesBroadcast(
    buildNodesInfo("BNODE", [
      { dest: END_NODE, destAlias: END_ALIAS, neighbour: END_NODE, quality: 200 },
    ]),
  );
  if (broadcast === null) throw new Error("seed parse failed");
  table.ingest(B_NODE, A_NODE, "p1", broadcast);
  return table;
}
