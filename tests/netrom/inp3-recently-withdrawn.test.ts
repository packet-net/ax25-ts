/**
 * Tests for the INP3 **recently-withdrawn** set on {@link NetRomRoutingTable}
 * (invariant W, design `docs/netrom-inp3-host-integration-design.md` §6): when a
 * destination loses its **last** `inp3`-bearing route — withdrawn at the horizon in
 * {@link NetRomRoutingTable.ingestRif}, dropped by
 * {@link NetRomRoutingTable.markNeighbourDown}, or aged out by
 * {@link NetRomRoutingTable.sweep} — it enters
 * {@link NetRomRoutingTable.recentlyWithdrawn} (a read-only peek), the host
 * {@link NetRomRoutingTable.drainRecentlyWithdrawn}s it ONCE at the start of a
 * fan-out round (snapshot+clear), and {@link NetRomRoutingTable.buildRif} emits one
 * horizon RIP per entry of the snapshot the host passes to it. The headline is that
 * the drained snapshot, handed to every neighbour's buildRif, carries the withdrawal
 * to each; and the load-bearing default-off guard: a quality-only markNeighbourDown /
 * sweep (the INP3-off path) never touches the set.
 *
 * TS port of `tests/Packet.NetRom.Tests/Routing/Inp3RecentlyWithdrawnTests.cs`. Same
 * cases, same assertions, same boundary values.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NETROM_ROUTING_DEFAULTS,
  NetRomRoutingTable,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import {
  INP3_HORIZON_MS,
  type Inp3Rif,
  type Inp3Rip,
  inp3RipIsHorizon,
} from "../../src/netrom/inp3-rif.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";

const Me = new Callsign("M0LTE", 0);
const NbrA = new Callsign("GB7RDG", 0);
const NbrB = new Callsign("GB7XYZ", 0);
const DestSot = new Callsign("GB7SOT", 0);
const DestMnc = new Callsign("GB7MNC", 0);

const FIXED_NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08T12:00:00Z

function newTable(): NetRomRoutingTable {
  return new NetRomRoutingTable(NETROM_ROUTING_DEFAULTS, () => FIXED_NOW);
}

function rip(destination: Callsign, hopCount: number, targetTimeMs: number): Inp3Rip {
  return { destination, hopCount, targetTimeMs, tlvs: [] };
}

function rif(...rips: Inp3Rip[]): Inp3Rif {
  return { rips };
}

function nodes(senderAlias: string, entries: NodesEntrySpec[] = []) {
  const bc = parseNodesBroadcast(buildNodesInfo(senderAlias, entries));
  expect(bc).not.toBeNull();
  return bc!;
}

/** The withdrawn set as comparable callsign strings (stable ordinal order). */
function withdrawnStrings(table: NetRomRoutingTable): string[] {
  return table.recentlyWithdrawn().map((c) => c.toString());
}

describe("Inp3 recently-withdrawn — population: where an INP3 route fully leaves", () => {
  it("ingesting a horizon rip withdraws the last inp3 route and records it", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    expect(table.recentlyWithdrawn()).toHaveLength(0); // learning is not a withdrawal

    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    expect(withdrawnStrings(table)).toEqual([DestSot.toString()]);
  });

  it("markNeighbourDown records a destination that loses its last inp3 route", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    table.markNeighbourDown(NbrA);

    expect(withdrawnStrings(table)).toEqual([DestSot.toString()]);
  });

  it("sweep records a destination whose last inp3 route ages out", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    // OBSINIT default is 6 → sweep it down to 0 to purge the route.
    for (let i = 0; i < 6; i++) {
      table.sweep();
    }

    expect(withdrawnStrings(table)).toEqual([DestSot.toString()]);
  });

  it("a destination that keeps another inp3 route is NOT withdrawn", () => {
    const table = newTable();
    // SOT reachable via BOTH neighbours. Dropping one leaves the other → not withdrawn.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100)));

    table.markNeighbourDown(NbrA);

    expect(table.recentlyWithdrawn()).toHaveLength(0);
  });

  it("withdrawing one route when another inp3 route survives does not record", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100)));

    // Withdraw only the NbrA route at the horizon — NbrB's INP3 route survives.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    expect(table.recentlyWithdrawn()).toHaveLength(0);
  });
});

describe("Inp3 recently-withdrawn — the default-off guard (design §7.1)", () => {
  it("a quality-only markNeighbourDown never populates the set", () => {
    const table = newTable();
    // A vanilla NODES quality route only — no ingestRif ever called. This is the
    // INP3-off world (the L4 dial-failure path runs markNeighbourDown with INP3 off).
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));

    table.markNeighbourDown(NbrA);

    expect(table.recentlyWithdrawn()).toHaveLength(0);
  });

  it("a quality-only sweep never populates the set", () => {
    const table = newTable();
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));

    for (let i = 0; i < 10; i++) {
      table.sweep(); // age the quality route all the way out
    }

    expect(table.recentlyWithdrawn()).toHaveLength(0);
  });

  it("a route that keeps its quality after inp3 withdrawal is still recorded", () => {
    const table = newTable();
    // A route carrying BOTH a quality metric (NODES) and an INP3 metric (RIF).
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    // Withdraw the INP3 metric at the horizon. The quality route SURVIVES (SOT stays
    // in the table for NODES) but SOT has left the INP3 time-space → recorded.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    expect(withdrawnStrings(table)).toEqual([DestSot.toString()]);
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(true);
  });
});

describe("Inp3 recently-withdrawn — buildRif emits from the host-drained snapshot", () => {
  it("buildRif emits one horizon rip for each withdrawn destination in the snapshot", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA); // SOT withdrawn

    // The host hands buildRif the snapshot (here peeked, to keep this single-RIF case
    // simple). One explicit one-shot horizon withdrawal per entry.
    const rifOut = table.buildRif(Me, NbrB, table.recentlyWithdrawn());

    const sotRips = rifOut.rips.filter((r) => r.destination.equals(DestSot));
    expect(sotRips).toHaveLength(1);
    expect(sotRips[0]!.targetTimeMs).toBe(INP3_HORIZON_MS);
    expect(inp3RipIsHorizon(sotRips[0]!)).toBe(true);
  });

  it("buildRif with no snapshot omits withdrawals", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA); // SOT withdrawn, but…

    // …a buildRif that is NOT handed the withdrawn snapshot (the default) appends no
    // withdrawal RIPs. The set is unaffected (buildRif never touches it).
    expect(
      table.buildRif(Me, NbrB).rips.some((r) => r.destination.equals(DestSot)),
    ).toBe(false);
    expect(table.recentlyWithdrawn()).toHaveLength(1);
  });

  it("the drained snapshot carries the withdrawal to every neighbour", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA); // SOT withdrawn

    // The host drains ONCE at the round start (snapshot+clear), then fans the SAME
    // snapshot out to every neighbour. Both RIFs carry the horizon withdrawal, and
    // the live set is already empty (drained).
    const snapshot = table.drainRecentlyWithdrawn();
    const towardB = table.buildRif(Me, NbrB, snapshot);
    const towardC = table.buildRif(Me, new Callsign("GB7ZZZ", 0), snapshot);

    expect(
      inp3RipIsHorizon(towardB.rips.find((r) => r.destination.equals(DestSot))!),
    ).toBe(true);
    expect(
      inp3RipIsHorizon(towardC.rips.find((r) => r.destination.equals(DestSot))!),
    ).toBe(true);
    expect(table.recentlyWithdrawn()).toHaveLength(0);
  });

  it("drainRecentlyWithdrawn returns then empties so a later rif omits the withdrawal", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA);

    const drained = table.drainRecentlyWithdrawn();
    expect(drained.map((c) => c.toString())).toEqual([DestSot.toString()]);
    expect(
      table.buildRif(Me, NbrB, drained).rips.some((r) =>
        r.destination.equals(DestSot),
      ),
    ).toBe(true);

    expect(table.recentlyWithdrawn()).toHaveLength(0);
    expect(
      table
        .buildRif(Me, NbrB, table.drainRecentlyWithdrawn())
        .rips.some((r) => r.destination.equals(DestSot)),
    ).toBe(false);
  });

  it("a re-learned destination is carried finite not poisoned in the same round", () => {
    const table = newTable();
    // SOT withdrawn via NbrA…
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA);
    expect(withdrawnStrings(table)).toContain(DestSot.toString());

    // …then re-learned via NbrB in the SAME round (before the host drains). It now
    // holds a finite INP3 route again, so buildRif must carry it FINITE, not as a
    // horizon withdrawal — the emitted-finite-dest is excluded from the horizon-RIP
    // pass even though it is still in the withdrawn snapshot the host passes.
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100)));

    // toward NbrA: SOT is NOT via NbrA anymore → finite, not poisoned
    const rifOut = table.buildRif(Me, NbrA, table.recentlyWithdrawn());
    const sotRips = rifOut.rips.filter((r) => r.destination.equals(DestSot));
    expect(sotRips).toHaveLength(1); // exactly one — finite, not both finite + horizon
    expect(inp3RipIsHorizon(sotRips[0]!)).toBe(false);
    expect(sotRips[0]!.targetTimeMs).toBe(130); // 100 + 20 + 10, quantised
  });

  it("the own node is never emitted as a withdrawal", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA);

    const rifOut = table.buildRif(Me, NbrB, table.recentlyWithdrawn());
    const own = rifOut.rips.filter((r) => r.destination.equals(Me));
    expect(own).toHaveLength(1);
    expect(inp3RipIsHorizon(own[0]!)).toBe(false);
    expect(rifOut.rips[0]!.destination.equals(Me)).toBe(true); // own-node first, at 0/0
  });

  it("re-withdrawing after a drain re-populates the set", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrA);
    table.drainRecentlyWithdrawn();
    expect(table.recentlyWithdrawn()).toHaveLength(0);

    // A fresh learn-then-withdraw cycle re-populates it (the next round re-advertises).
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100)));
    table.markNeighbourDown(NbrB);

    expect(withdrawnStrings(table)).toEqual([DestSot.toString()]);
  });

  it("multiple withdrawn destinations are returned in stable ordinal order", () => {
    const table = newTable();
    table.ingestRif(
      NbrA,
      Me,
      50,
      rif(rip(DestSot, 1, 100), rip(DestMnc, 1, 100)),
    );
    table.markNeighbourDown(NbrA); // both lose their last INP3 route

    // GB7MNC < GB7SOT ordinally.
    expect(withdrawnStrings(table)).toEqual([
      DestMnc.toString(),
      DestSot.toString(),
    ]);
  });
});
