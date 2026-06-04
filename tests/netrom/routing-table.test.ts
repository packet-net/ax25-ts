/**
 * NET/ROM routing-table maintenance — TS port of
 * `tests/Packet.NetRom.Tests/Routing/NetRomRoutingTableTests.cs`. Covers the
 * canonical processing heuristics: neighbour creation, the assumed direct route,
 * combined-quality learning, the trivial-loop guard, the 3-best route cap,
 * in-place re-advertisement, obsolescence decay/purge/refresh, the MINQUAL
 * floor, the destination cap, and snapshot ordering.
 *
 * The clock is injected (a mutable `() => now` closure, the TS analogue of the
 * C# `FakeTimeProvider`) so last-heard stamps and decay are deterministic.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NETROM_ROUTING_DEFAULTS,
  NetRomRoutingTable,
  type NetRomRoutingOptions,
  combineQuality,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";

const Me = new Callsign("M0LTE", 0);
const NbrA = new Callsign("GB7RDG", 0); // a heard neighbour (originator)
const NbrB = new Callsign("GB7XYZ", 0); // another heard neighbour
const DestSot = new Callsign("GB7SOT", 0);
const DestMnc = new Callsign("GB7MNC", 0);

const FIXED_NOW = Date.UTC(2026, 5, 4, 12, 0, 0); // 2026-06-04T12:00:00Z

function broadcast(senderAlias: string, entries: NodesEntrySpec[] = []) {
  const bc = parseNodesBroadcast(buildNodesInfo(senderAlias, entries));
  expect(bc).not.toBeNull();
  return bc!;
}

function newTable(
  options: NetRomRoutingOptions = NETROM_ROUTING_DEFAULTS,
): { table: NetRomRoutingTable; tick: (ms: number) => void } {
  let now = FIXED_NOW;
  const table = new NetRomRoutingTable(options, () => now);
  return { table, tick: (ms: number) => (now += ms) };
}

describe("NetRomRoutingTable — ingest heuristics", () => {
  it("hearing a broadcast records the originator as a neighbour", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ"));

    const snap = table.snapshot();
    expect(snap.neighbours).toHaveLength(1);
    const n = snap.neighbours[0]!;
    expect(n.neighbour.equals(NbrA)).toBe(true);
    expect(n.alias).toBe("RDGBPQ");
    expect(n.portId).toBe("vhf");
    expect(n.pathQuality).toBe(192); // default neighbour quality
    expect(n.lastHeard).toBe(FIXED_NOW);
  });

  it("assumes a direct route to the originator at path quality", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ"));

    const dest = table.snapshot().destinations.find((d) => d.destination.equals(NbrA));
    expect(dest).toBeDefined();
    expect(dest!.bestRoute).not.toBeNull();
    expect(dest!.bestRoute!.neighbour.equals(NbrA)).toBe(true);
    expect(dest!.bestRoute!.quality).toBe(192);
  });

  it("learns an advertised destination at the combined quality", () => {
    const { table } = newTable();
    // RDG advertises it can reach SOT via XYZ at quality 200. Our path to RDG is
    // the default 192. Derived = (200*192 + 128)/256 = 150.5 → 150.
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
    ]));

    const sot = table.snapshot().destinations.find((d) => d.destination.equals(DestSot));
    expect(sot).toBeDefined();
    expect(sot!.alias).toBe("SOT");
    expect(sot!.bestRoute!.neighbour.equals(NbrA)).toBe(true); // we forward to RDG (the originator)
    expect(sot!.bestRoute!.quality).toBe(combineQuality(200, 192)); // 150
  });

  it("trivial-loop guard zeroes a route whose best-neighbour is us", () => {
    const { table } = newTable();
    // RDG advertises a destination reachable via US (M0LTE) — a loop. The route
    // becomes quality 0, which is never kept, so DestMnc gets no route.
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ", [
      { dest: DestMnc, destAlias: "MNC", neighbour: Me, quality: 200 },
    ]));

    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestMnc)),
    ).toBe(false);
  });

  it("keeps only the three best routes per destination", () => {
    const { table } = newTable();
    // Four distinct originators each advertise SOT at different qualities → four
    // routes, capped to 3.
    const n1 = new Callsign("GB7AAA", 0);
    const n2 = new Callsign("GB7BBB", 0);
    const n3 = new Callsign("GB7CCC", 0);
    const n4 = new Callsign("GB7DDD", 0);
    table.ingest(n1, Me, "vhf", broadcast("AAA", [{ dest: DestSot, destAlias: "SOT", neighbour: n1, quality: 250 }]));
    table.ingest(n2, Me, "vhf", broadcast("BBB", [{ dest: DestSot, destAlias: "SOT", neighbour: n2, quality: 200 }]));
    table.ingest(n3, Me, "vhf", broadcast("CCC", [{ dest: DestSot, destAlias: "SOT", neighbour: n3, quality: 150 }]));
    table.ingest(n4, Me, "vhf", broadcast("DDD", [{ dest: DestSot, destAlias: "SOT", neighbour: n4, quality: 100 }]));

    const sot = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    expect(sot.routes).toHaveLength(3); // the per-destination route cap is 3
    const qualities = sot.routes.map((r) => r.quality);
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a)); // best first
    expect(sot.routes.some((r) => r.neighbour.equals(n4))).toBe(false); // weakest dropped
  });

  it("re-advertising updates the route in place, not duplicates it", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }]));
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 100 }]));

    const sot = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    expect(sot.routes).toHaveLength(1); // the same (dest, via-neighbour) is one route, refreshed
    expect(sot.bestRoute!.quality).toBe(combineQuality(100, 192));
  });
});

describe("NetRomRoutingTable — obsolescence", () => {
  it("initialises a route to OBSINIT and decrements each sweep", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }]));

    expect(table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.obsolescence).toBe(6);

    table.sweep();
    expect(table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.obsolescence).toBe(5);
  });

  it("purges a route when its obsolescence reaches zero", () => {
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, obsoleteInitial: 2 });
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }]));

    table.sweep(); // 2 -> 1
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(true);

    const purged = table.sweep(); // 1 -> 0 → purge
    expect(purged).toBeGreaterThan(0);
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(false);
  });

  it("a fresh broadcast resets obsolescence back to OBSINIT", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }]));
    table.sweep(); // 6 -> 5
    table.sweep(); // 5 -> 4
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }])); // refresh

    expect(table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.obsolescence).toBe(6);
  });

  it("sweeping a purged destination's only neighbour drops the neighbour too", () => {
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, obsoleteInitial: 1 });
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 }]));

    expect(table.snapshot().neighbours).toHaveLength(1);
    table.sweep(); // purges both the direct route to RDG and the SOT route
    const snap = table.snapshot();
    expect(snap.destinations).toHaveLength(0);
    expect(snap.neighbours).toHaveLength(0); // a neighbour with no surviving route is an orphan
  });
});

describe("NetRomRoutingTable — MINQUAL floor", () => {
  it("a route below the floor is dropped by a higher MINQUAL but kept by the default", () => {
    // RDG advertises SOT via XYZ at quality 80 → derived (80*192+128)/256 = 60.
    const entries: NodesEntrySpec[] = [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 }];

    // Default floor (0): the route is learned.
    const lenient = newTable();
    lenient.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries));
    expect(lenient.table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(true);

    // Raised floor (MINQUAL 128): the derived 60 is below the floor → dropped.
    const strict = newTable({ ...NETROM_ROUTING_DEFAULTS, minQuality: 128 });
    strict.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries));
    expect(strict.table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(false);
  });

  it("a re-advertisement that falls below the floor removes the existing route", () => {
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, minQuality: 128 });
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 250 }])); // derived 187 — kept
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(true);

    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 }])); // derived 60 — below floor
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(false);
  });
});

describe("NetRomRoutingTable — destination cap + snapshot shape", () => {
  it("the destination list stops growing at the cap", () => {
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, maxDestinations: 2 });

    // Originator NbrA itself counts as one destination (its assumed direct
    // route). Advertise two more; only one fits.
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
      { dest: DestMnc, destAlias: "MNC", neighbour: NbrB, quality: 200 },
    ]));

    expect(table.snapshot().destinations).toHaveLength(2);
  });

  it("orders destinations by alias then callsign", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
      { dest: DestMnc, destAlias: "MNC", neighbour: NbrB, quality: 200 },
    ]));

    const aliases = table
      .snapshot()
      .destinations.map((d) => d.alias)
      .filter((a) => a === "MNC" || a === "SOT");
    expect(aliases).toEqual(["MNC", "SOT"]); // ascending
  });

  it("an empty table yields an empty snapshot", () => {
    const { table } = newTable();
    const snap = table.snapshot();
    expect(snap.destinations).toHaveLength(0);
    expect(snap.neighbours).toHaveLength(0);
    expect(table.destinationCount).toBe(0);
    expect(table.neighbourCount).toBe(0);
  });
});
