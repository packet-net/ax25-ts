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
  NETROM_NEIGHBOUR_KEY_SEPARATOR,
  NetRomRoutingTable,
  type NetRomRoutingOptions,
  combineQuality,
  neighbourKey,
  neighbourKeyPort,
  neighbourKeyCallsign,
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

  it("an advertisement of us via a third node is not learned or re-advertised", () => {
    const { table } = newTable();
    // RDG advertises US (M0LTE) as a destination reachable via XYZ, a third
    // node, so the best-neighbour loop guard (which only catches "via us") does
    // not fire. We must still never learn a route to ourselves, or our own
    // callsign ends up in our own NODES broadcast (LinBPQ L3Code.c:456 skips
    // destination == MYCALL).
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ", [
      { dest: Me, destAlias: "MYNODE", neighbour: NbrB, quality: 200 },
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
    ]));

    // a route to ourselves is never learned
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(Me)),
    ).toBe(false);
    // and so never re-advertised
    expect(
      table.buildAdvertisement(0).some((e) => e.destination.equals(Me)),
    ).toBe(false);

    // The rest of the broadcast is unaffected.
    expect(
      table.buildAdvertisement(0).some((e) => e.destination.equals(DestSot)),
    ).toBe(true);
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

describe("NetRomRoutingTable — link-down failover (markNeighbourDown)", () => {
  it("drops a down neighbour's routes at once without waiting for the sweep", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 }]));
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(true);

    const dropped = table.markNeighbourDown("vhf", NbrA);

    expect(dropped).toBeGreaterThan(0);
    const snap = table.snapshot();
    expect(snap.destinations).toHaveLength(0); // every route forwarded through the down neighbour
    expect(snap.neighbours.some((n) => n.neighbour.equals(NbrA))).toBe(false); // the neighbour is removed too
  });

  it("leaves an alternate route to the same destination (fails over)", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 250 }]));
    table.ingest(NbrB, Me, "vhf", broadcast("XYZ", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 150 }]));
    expect(table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.neighbour.equals(NbrA)).toBe(true);

    table.markNeighbourDown("vhf", NbrA);

    const after = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    expect(after.routes.some((r) => r.neighbour.equals(NbrA))).toBe(false);
    expect(after.bestRoute!.neighbour.equals(NbrB)).toBe(true); // surviving route is now best — failed over
  });

  it("is a no-op for an unknown neighbour", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [{ dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 }]));

    expect(table.markNeighbourDown("vhf", NbrB)).toBe(0);
    expect(table.snapshot().destinations.some((d) => d.destination.equals(DestSot))).toBe(true);
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

describe("NetRomRoutingTable - per-port QUALITY (neighbourQuality)", () => {
  it("a per-port quality overrides the default for a neighbour on that port", () => {
    const { table } = newTable();
    // This port advertises quality 191 (e.g. a slightly worse-grade link).
    table.ingest(NbrA, Me, "hf", broadcast("RDGBPQ"), 191);

    const snap = table.snapshot();
    expect(snap.neighbours).toHaveLength(1);
    expect(snap.neighbours[0]!.pathQuality).toBe(191);
    const direct = snap.destinations.find((d) => d.destination.equals(NbrA))!;
    expect(direct.bestRoute!.quality).toBe(191);
  });

  it("an omitted per-port quality falls back to the table default", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ"));

    expect(table.snapshot().neighbours[0]!.pathQuality).toBe(192); // the canonical default
  });

  it("a mixed-grade node advertises the correct quality per port", () => {
    // A GB7RDG-style mixed-grade node: 191 on one port, 192 on another. Two
    // neighbours heard on two different-grade ports learn their port's quality
    // independently, and a destination learned via each is combined against that
    // port's basis.
    const { table } = newTable();
    table.ingest(NbrA, Me, "port-191", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
    ]), 191);
    table.ingest(NbrB, Me, "port-192", broadcast("XYZ", [
      { dest: DestMnc, destAlias: "MNC", neighbour: NbrA, quality: 200 },
    ]), 192);

    const snap = table.snapshot();
    expect(snap.neighbours.find((n) => n.neighbour.equals(NbrA))!.pathQuality).toBe(191);
    expect(snap.neighbours.find((n) => n.neighbour.equals(NbrB))!.pathQuality).toBe(192);
    expect(
      snap.destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.quality,
    ).toBe(combineQuality(200, 191));
    expect(
      snap.destinations.find((d) => d.destination.equals(DestMnc))!.bestRoute!.quality,
    ).toBe(combineQuality(200, 192));
  });

  it("a per-port quality change is reflected on the next broadcast", () => {
    // A QUALITY edit (hot-reload) takes effect on the next NODES ingest: the
    // cached neighbour path quality is refreshed, not pinned to first-heard.
    const { table } = newTable();
    table.ingest(NbrA, Me, "hf", broadcast("RDGBPQ"), 191);
    expect(table.snapshot().neighbours[0]!.pathQuality).toBe(191);

    table.ingest(NbrA, Me, "hf", broadcast("RDGBPQ"), 200);
    expect(table.snapshot().neighbours[0]!.pathQuality).toBe(200);
  });

  it("a per-port quality of 255 yields higher direct + derived qualities than the default", () => {
    const entries: NodesEntrySpec[] = [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
    ];

    const dflt = newTable();
    dflt.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries));
    const best = newTable();
    best.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries), 255);

    const directDefault = dflt.table
      .snapshot()
      .destinations.find((d) => d.destination.equals(NbrA))!.bestRoute!.quality;
    const directBest = best.table
      .snapshot()
      .destinations.find((d) => d.destination.equals(NbrA))!.bestRoute!.quality;
    expect(directDefault).toBe(192);
    expect(directBest).toBe(255);

    const derivedDefault = dflt.table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.quality;
    const derivedBest = best.table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!.bestRoute!.quality;
    expect(derivedDefault).toBe(combineQuality(200, 192));
    expect(derivedBest).toBe(combineQuality(200, 255));
    expect(derivedBest).toBeGreaterThan(derivedDefault);
  });
});

describe("NetRomRoutingTable - per-port MINQUAL (minQuality)", () => {
  it("a per-port MINQUAL drops a route the table default would keep", () => {
    // RDG advertises SOT via XYZ at quality 80 -> derived (80*192+128)/256 = 60.
    const entries: NodesEntrySpec[] = [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 },
    ];

    // Table-wide floor is the default 0; with no per-port override it is kept.
    const dflt = newTable();
    dflt.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries));
    expect(
      dflt.table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(true);

    // The SAME table default, but a per-port MINQUAL of 200 on this ingest: the
    // derived 60 is below the per-port floor, so the route is NOT kept.
    const perPort = newTable();
    perPort.table.ingest(NbrA, Me, "rf", broadcast("RDG", entries), undefined, 200);
    expect(
      perPort.table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(false);
  });

  it("an omitted per-port MINQUAL falls back to the table floor", () => {
    // Table-wide MINQUAL 128, per-port unset means the table floor applies, so the
    // derived-60 route is dropped exactly as the table-wide case would.
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, minQuality: 128 });
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 },
    ]));
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(false);
  });

  it("a per-port MINQUAL overrides a higher table floor to keep a route", () => {
    // Table-wide MINQUAL 128 would drop a derived-60 route, but this port relaxes
    // the floor to 0, so the route IS kept on that port (per-port wins both ways).
    const { table } = newTable({ ...NETROM_ROUTING_DEFAULTS, minQuality: 128 });
    table.ingest(NbrA, Me, "open", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 },
    ]), undefined, 0);
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(true);
  });

  it("a re-advertisement below the per-port floor removes an existing route", () => {
    const { table } = newTable();
    // First a strong advert (derived 187) is kept under the per-port floor of 100.
    table.ingest(NbrA, Me, "rf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 250 },
    ]), undefined, 100);
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(true);

    // A weaker re-advert (derived 60) on the same port now falls below the
    // per-port floor, so the existing route is removed.
    table.ingest(NbrA, Me, "rf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 80 },
    ]), undefined, 100);
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(false);
  });

  it("omitting both per-port parameters keeps today's behaviour", () => {
    // The regression guard for the optional-parameter mirror: a 4-argument ingest
    // is byte-for-byte what it always was.
    const entries: NodesEntrySpec[] = [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrB, quality: 200 },
    ];
    const bare = newTable();
    bare.table.ingest(NbrA, Me, "vhf", broadcast("RDG", entries));
    const explicitDefaults = newTable();
    explicitDefaults.table.ingest(
      NbrA,
      Me,
      "vhf",
      broadcast("RDG", entries),
      NETROM_ROUTING_DEFAULTS.defaultNeighbourQuality,
      NETROM_ROUTING_DEFAULTS.minQuality,
    );

    expect(bare.table.snapshot()).toEqual(explicitDefaults.table.snapshot());
    expect(bare.table.snapshot().neighbours[0]!.pathQuality).toBe(192);
    expect(
      bare.table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!
        .bestRoute!.quality,
    ).toBe(combineQuality(200, 192));
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

describe("NetRomRoutingTable - per-port neighbours ((portId, callsign) keys)", () => {
  it("the same callsign heard on two ports keeps two neighbour rows with their own quality", () => {
    const { table } = newTable();
    // GB7RDG is heard on "vhf" at quality 191 and on "hf" at quality 150.
    table.ingest(NbrA, Me, "vhf", broadcast("RDGBPQ"), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDGBPQ"), 150);

    const snap = table.snapshot();
    expect(snap.neighbours).toHaveLength(2); // one row per (portId, callsign) key
    const vhf = snap.neighbours.find((n) => n.portId === "vhf")!;
    const hf = snap.neighbours.find((n) => n.portId === "hf")!;
    expect(vhf.neighbour.equals(NbrA)).toBe(true);
    expect(hf.neighbour.equals(NbrA)).toBe(true);
    expect(vhf.pathQuality).toBe(191);
    expect(hf.pathQuality).toBe(150);

    // Two direct routes to the originator too, one per port, each at its own
    // quality - the second ingest did NOT overwrite the first port's row.
    const direct = snap.destinations.find((d) => d.destination.equals(NbrA))!;
    expect(direct.routes).toHaveLength(2);
    const qualities = direct.routes.map((r) => r.quality).sort((a, b) => b - a);
    expect(qualities).toEqual([191, 150]);
    expect(direct.routes.map((r) => r.portId).sort()).toEqual(["hf", "vhf"]);
  });

  it("the better port wins route selection", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 150);

    const sot = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    expect(sot.routes).toHaveLength(2);
    // Best quality wins: the route via the vhf port (191 basis) beats hf (150).
    expect(sot.bestRoute!.portId).toBe("vhf");
    expect(sot.bestRoute!.quality).toBe(combineQuality(200, 191));
    expect(sot.routes[1]!.portId).toBe("hf");
    expect(sot.routes[1]!.quality).toBe(combineQuality(200, 150));
  });

  it("markNeighbourDown on one port leaves the other port's routes intact", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 150);

    // A failed dial on the vhf port drops ONLY the (vhf, NbrA) key.
    const dropped = table.markNeighbourDown("vhf", NbrA);
    expect(dropped).toBeGreaterThan(0);

    const snap = table.snapshot();
    // The hf neighbour row + its routes survive the vhf failure.
    expect(snap.neighbours).toHaveLength(1);
    expect(snap.neighbours[0]!.portId).toBe("hf");
    const sot = snap.destinations.find((d) => d.destination.equals(DestSot))!;
    expect(sot.routes).toHaveLength(1);
    expect(sot.bestRoute!.portId).toBe("hf"); // failed over to the same callsign on hf
    expect(sot.bestRoute!.quality).toBe(combineQuality(200, 150));
  });

  it("markPortDown drops only that port's neighbour rows and routes", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 150);
    table.ingest(NbrB, Me, "vhf", broadcast("XYZ", [
      { dest: DestMnc, destAlias: "MNC", neighbour: NbrB, quality: 200 },
    ]));

    const dropped = table.markPortDown("vhf");
    // The vhf port carried: direct-to-RDG, SOT-via-RDG, direct-to-XYZ, MNC-via-XYZ.
    expect(dropped).toBe(4);

    const snap = table.snapshot();
    expect(snap.neighbours).toHaveLength(1);
    expect(snap.neighbours[0]!.portId).toBe("hf"); // only the hf row survives
    // SOT keeps its hf route; MNC lost its only route and with it the destination.
    expect(snap.destinations.some((d) => d.destination.equals(DestSot))).toBe(true);
    expect(snap.destinations.some((d) => d.destination.equals(DestMnc))).toBe(false);
    // An unknown port is a no-op.
    expect(table.markPortDown("nope")).toBe(0);
  });

  it("the NODES advertisement still emits one entry per destination at the better quality", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 150);

    const entries = table.buildAdvertisement(0);
    // ONE entry per destination - the wire carries the best route's neighbour
    // CALLSIGN and quality, no port. Two destinations: RDG itself + SOT.
    expect(entries).toHaveLength(2);
    const sot = entries.find((e) => e.destination.equals(DestSot))!;
    expect(sot.bestNeighbour.equals(NbrA)).toBe(true);
    expect(sot.quality).toBe(combineQuality(200, 191)); // the better port's quality
    expect(Object.keys(sot).sort()).toEqual(
      ["bestNeighbour", "destination", "destinationAlias", "quality"],
    ); // no port field on the wire shape
  });

  it("obsolescence decays each per-port route independently", () => {
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 150);

    table.sweep(); // both 6 -> 5
    table.sweep(); // both 5 -> 4
    // Only the vhf port keeps broadcasting: its route refreshes, hf keeps decaying.
    table.ingest(NbrA, Me, "vhf", broadcast("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]), 191);

    const sot = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    const vhfRoute = sot.routes.find((r) => r.portId === "vhf")!;
    const hfRoute = sot.routes.find((r) => r.portId === "hf")!;
    expect(vhfRoute.obsolescence).toBe(6); // refreshed on its own key
    expect(hfRoute.obsolescence).toBe(4); // aged on its own key

    // Four more sweeps age the silent hf route out entirely; vhf survives.
    table.sweep();
    table.sweep();
    table.sweep();
    table.sweep();
    const after = table.snapshot().destinations.find((d) => d.destination.equals(DestSot))!;
    expect(after.routes.some((r) => r.portId === "hf")).toBe(false);
    expect(after.routes.some((r) => r.portId === "vhf")).toBe(true);
  });

  it("equal-quality ties break deterministically by canonical port order, then callsign", () => {
    // Same neighbour quality on both ports → equal route qualities. The default
    // (no host port order) is a stable string-ordinal comparison of the port ids.
    const { table } = newTable();
    table.ingest(NbrA, Me, "b-port", broadcast("RDG"), 190);
    table.ingest(NbrA, Me, "a-port", broadcast("RDG"), 190);

    const direct = table.snapshot().destinations.find((d) => d.destination.equals(NbrA))!;
    expect(direct.routes).toHaveLength(2);
    expect(direct.bestRoute!.portId).toBe("a-port"); // ordinal: "a-port" < "b-port"

    // A host-supplied port order wins over the ordinal default.
    const ranked = new NetRomRoutingTable(
      NETROM_ROUTING_DEFAULTS,
      () => FIXED_NOW,
      (portId) => (portId === "b-port" ? 0 : 1), // the host prefers b-port
    );
    ranked.ingest(NbrA, Me, "b-port", broadcast("RDG"), 190);
    ranked.ingest(NbrA, Me, "a-port", broadcast("RDG"), 190);
    const rankedDirect = ranked
      .snapshot()
      .destinations.find((d) => d.destination.equals(NbrA))!;
    expect(rankedDirect.bestRoute!.portId).toBe("b-port");
  });

  it("two ports with different neighbour qualities advertise per port and never overwrite", () => {
    // Re-hearing the neighbour on one port refreshes only that port's quality.
    const { table } = newTable();
    table.ingest(NbrA, Me, "vhf", broadcast("RDG"), 191);
    table.ingest(NbrA, Me, "hf", broadcast("RDG"), 150);
    table.ingest(NbrA, Me, "hf", broadcast("RDG"), 160); // hf QUALITY edit

    const snap = table.snapshot();
    expect(snap.neighbours.find((n) => n.portId === "vhf")!.pathQuality).toBe(191); // untouched
    expect(snap.neighbours.find((n) => n.portId === "hf")!.pathQuality).toBe(160);
  });

  it("neighbourKey round-trips (portId, callsign) and rejects a portId containing the separator", () => {
    const key = neighbourKey("vhf", NbrA);
    expect(key).toBe(`vhf${NETROM_NEIGHBOUR_KEY_SEPARATOR}${NbrA.toString()}`);
    expect(neighbourKeyPort(key)).toBe("vhf");
    expect(neighbourKeyCallsign(key)).toBe(NbrA.toString());

    // The split accessors slice at the first separator, so a portId that itself
    // contained one would mis-attribute the callsign half and silently corrupt
    // per-port teardown. neighbourKey fails fast on the misconfiguration instead.
    expect(() => neighbourKey(`gw${NETROM_NEIGHBOUR_KEY_SEPARATOR}1`, NbrA)).toThrow(RangeError);
  });
});
