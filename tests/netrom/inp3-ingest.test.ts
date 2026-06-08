/**
 * Tests for INP3 RIF ingestion into the routing table
 * ({@link NetRomRoutingTable.ingestRif}) — the second metric space (measured
 * target time, lowest-best) learned alongside the NODES quality space. The locked
 * ingestion math is `localTargetTimeMs = rip.targetTimeMs + neighbourSnttMs + 10`,
 * `localHopCount = rip.hopCount + 1`, with the 600 s horizon withdrawing the
 * dest-via-neighbour INP3 route (design doc `docs/netrom-inp3-i3-design.md` §2 / §5.2).
 *
 * TS port of `tests/Packet.NetRom.Tests/Routing/Inp3IngestTests.cs`. Same cases,
 * same assertions, same boundary values.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NETROM_ROUTING_DEFAULTS,
  NetRomRoutingTable,
  type NetRomRoute,
  type NetRomRoutingOptions,
  combineQuality,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import {
  INP3_HORIZON_MS,
  type Inp3Rif,
  type Inp3Rip,
  inp3TlvAlias,
} from "../../src/netrom/inp3-rif.js";
import { SNTT_UNSET } from "../../src/netrom/inp3-sntt.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";

const Me = new Callsign("M0LTE", 0);
const NbrA = new Callsign("GB7RDG", 0); // the interlink RIF arrived on
const NbrB = new Callsign("GB7XYZ", 0); // a second neighbour
const DestSot = new Callsign("GB7SOT", 0);
const DestMnc = new Callsign("GB7MNC", 0);

const FIXED_NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08T12:00:00Z

function newTable(
  options: NetRomRoutingOptions = NETROM_ROUTING_DEFAULTS,
): NetRomRoutingTable {
  return new NetRomRoutingTable(options, () => FIXED_NOW);
}

function rip(
  destination: Callsign,
  hopCount: number,
  targetTimeMs: number,
  alias?: string,
): Inp3Rip {
  return {
    destination,
    hopCount,
    targetTimeMs,
    tlvs: alias === undefined ? [] : [inp3TlvAlias(alias)],
  };
}

function rif(...rips: Inp3Rip[]): Inp3Rif {
  return { rips };
}

function routeVia(
  table: NetRomRoutingTable,
  dest: Callsign,
  via: Callsign,
): NetRomRoute | undefined {
  const d = table.snapshot().destinations.find((x) => x.destination.equals(dest));
  return d?.routes.find((r) => r.neighbour.equals(via));
}

function nodes(
  senderAlias: string,
  entries: NodesEntrySpec[] = [],
) {
  const bc = parseNodesBroadcast(buildNodesInfo(senderAlias, entries));
  expect(bc).not.toBeNull();
  return bc!;
}

describe("Inp3 ingest — upsert", () => {
  it("ingesting a rif learns an inp3 time-route via the carrying neighbour", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100, "SOT")));

    const route = routeVia(table, DestSot, NbrA);
    expect(route).toBeDefined();
    expect(route!.neighbour.equals(NbrA)).toBe(true);
    expect(route!.inp3).toBeDefined();
    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    expect(dest.alias).toBe("SOT");
  });

  it("a pure inp3 route has quality zero so it is invisible to the quality path", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    const route = routeVia(table, DestSot, NbrA)!;
    expect(route.quality).toBe(0);
    expect(route.inp3).toBeDefined();
  });

  it("re-ingesting the same dest via the same neighbour refreshes the metric in place", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 300)));

    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    expect(dest.routes).toHaveLength(1);
    expect(dest.routes[0]!.inp3!.targetTimeMs).toBe(300 + 50 + 10);
  });
});

describe("Inp3 ingest — target-time accumulation", () => {
  it("local target time is peer time plus link sntt plus ten ms per hop", () => {
    const table = newTable();
    // peer says 100 ms to SOT in 2 hops; our link to the neighbour measures 75 ms.
    table.ingestRif(NbrA, Me, 75, rif(rip(DestSot, 2, 100)));

    const route = routeVia(table, DestSot, NbrA)!;
    expect(route.inp3!.targetTimeMs).toBe(100 + 75 + 10);
    expect(route.inp3!.hopCount).toBe(3); // one more hop — through us
  });

  it("per-hop increment keeps target time strictly increasing across a zero ms link", () => {
    const table = newTable();
    // A same-host / loopback link measures ~0 ms and the peer advertises 0 ms.
    table.ingestRif(NbrA, Me, 0, rif(rip(DestSot, 0, 0)));

    const route = routeVia(table, DestSot, NbrA)!;
    expect(route.inp3!.targetTimeMs).toBe(10); // the +10 ms per-hop floor
    expect(route.inp3!.hopCount).toBe(1);
  });

  it("full millisecond precision is kept not requantised to the ten ms granule", () => {
    const table = newTable();
    // Wire target time is always a 10 ms multiple, but the SNTT need not be — 73 ms here.
    table.ingestRif(NbrA, Me, 73, rif(rip(DestSot, 1, 100)));

    const route = routeVia(table, DestSot, NbrA)!;
    expect(route.inp3!.targetTimeMs).toBe(183); // 100 + 73 + 10 — full ms
  });

  it("best inp3 route per destination is the lowest target time", () => {
    const table = newTable();
    // Two neighbours both reach SOT; via NbrB is the faster path.
    table.ingestRif(NbrA, Me, 200, rif(rip(DestSot, 1, 100))); // 310
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100))); // 130

    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    const bestInp3 = dest.routes
      .filter((r) => r.inp3 !== undefined)
      .sort(
        (a, b) =>
          a.inp3!.targetTimeMs - b.inp3!.targetTimeMs ||
          a.inp3!.hopCount - b.inp3!.hopCount ||
          (a.neighbour.toString() < b.neighbour.toString() ? -1 : 1),
      )[0]!;
    expect(bestInp3.neighbour.equals(NbrB)).toBe(true);
    expect(bestInp3.inp3!.targetTimeMs).toBe(130);
  });
});

describe("Inp3 ingest — horizon withdraws", () => {
  it("a rip at or over the horizon is a withdrawal clearing the inp3 metric", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    expect(routeVia(table, DestSot, NbrA)!.inp3).toBeDefined();

    // The peer now advertises SOT at the 600 s horizon → withdrawal.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    expect(routeVia(table, DestSot, NbrA)).toBeUndefined();
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DestSot)),
    ).toBe(false);
  });

  it("a computed target time reaching the horizon also withdraws", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    // peer target just under the horizon, but the link SNTT pushes the computed
    // value to/over it → withdrawal even though rip.isHorizon is false.
    table.ingestRif(NbrA, Me, 100, rif(rip(DestSot, 1, INP3_HORIZON_MS - 10)));

    expect(routeVia(table, DestSot, NbrA)).toBeUndefined();
  });

  it("withdrawal clears only the inp3 metric and leaves a coexisting quality route", () => {
    const table = newTable();
    // First a NODES quality route, then an INP3 metric attached to the same (dest, via).
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    const both = routeVia(table, DestSot, NbrA)!;
    expect(both.quality).toBeGreaterThan(0);
    expect(both.inp3).toBeDefined();

    // Withdraw via the horizon — the quality route must survive, the INP3 metric cleared.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    const after = routeVia(table, DestSot, NbrA);
    expect(after).toBeDefined();
    expect(after!.inp3).toBeUndefined();
    expect(after!.quality).toBe(combineQuality(200, 192));
  });

  it("an unset sntt never withdraws a route it never learned", () => {
    const table = newTable();
    // A NODES quality route exists; no SNTT measured for this link yet.
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));

    // A non-horizon RIP arrives but the link is un-probed: skip — do NOT withdraw.
    table.ingestRif(NbrA, Me, SNTT_UNSET, rif(rip(DestSot, 1, 100)));

    const route = routeVia(table, DestSot, NbrA);
    expect(route).toBeDefined();
    expect(route!.inp3).toBeUndefined();
    expect(route!.quality).toBeGreaterThan(0);
  });

  it("a horizon rip withdraws even when the link is unmeasured", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    expect(routeVia(table, DestSot, NbrA)!.inp3).toBeDefined();

    // Even with no current SNTT measurement, an explicit horizon RIP is a withdrawal.
    table.ingestRif(NbrA, Me, SNTT_UNSET, rif(rip(DestSot, 1, INP3_HORIZON_MS)));

    expect(routeVia(table, DestSot, NbrA)).toBeUndefined();
  });
});

describe("Inp3 ingest — hop limit", () => {
  it("a rip whose local hop count exceeds the hop limit is not learned", () => {
    const table = newTable();
    // hopLimit 5: a RIP at 5 hops becomes 6 local → over the limit → not learned.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 5, 100)), 5);

    expect(routeVia(table, DestSot, NbrA)).toBeUndefined();
  });

  it("a rip at exactly the hop limit is learned", () => {
    const table = newTable();
    // hopLimit 5: a RIP at 4 hops becomes 5 local → at the limit → learned.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 4, 100)), 5);

    const route = routeVia(table, DestSot, NbrA);
    expect(route).toBeDefined();
    expect(route!.inp3!.hopCount).toBe(5);
  });

  it("the default hop limit is thirty", () => {
    expect(NetRomRoutingTable.DEFAULT_HOP_LIMIT).toBe(30);
    const table = newTable();
    // 29 hops → 30 local, learned at the default; 30 hops → 31 local, dropped.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 29, 100)));
    table.ingestRif(NbrB, Me, 50, rif(rip(DestMnc, 30, 100)));

    expect(routeVia(table, DestSot, NbrA)).toBeDefined();
    expect(routeVia(table, DestMnc, NbrB)).toBeUndefined();
  });
});

describe("Inp3 ingest — trivial-loop guard", () => {
  it("a rip whose destination is us is skipped", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(Me, 1, 100)));

    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(Me)),
    ).toBe(false);
  });
});

describe("Inp3 ingest — route cap", () => {
  it("the per-destination route cap is respected evicting lowest quality first", () => {
    const options = { ...NETROM_ROUTING_DEFAULTS, maxRoutesPerDestination: 2 };
    const table = newTable(options);
    const n1 = new Callsign("GB7AAA", 0);
    const n2 = new Callsign("GB7BBB", 0);
    const n3 = new Callsign("GB7CCC", 0);

    // Three INP3-only routes (all quality 0) to SOT via three neighbours → capped to 2.
    table.ingestRif(n1, Me, 10, rif(rip(DestSot, 1, 100)));
    table.ingestRif(n2, Me, 20, rif(rip(DestSot, 1, 100)));
    table.ingestRif(n3, Me, 30, rif(rip(DestSot, 1, 100)));

    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    expect(dest.routes).toHaveLength(2);
  });

  it("an inp3-only route is evicted in favour of a quality route when capped", () => {
    const options = { ...NETROM_ROUTING_DEFAULTS, maxRoutesPerDestination: 1 };
    const table = newTable(options);
    // A quality route via NbrA, then an INP3-only route via NbrB: cap 1 keeps the
    // higher-quality (NbrA) route — eviction is quality-first (AMBIGUITY-I3-2).
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    table.ingestRif(NbrB, Me, 10, rif(rip(DestSot, 1, 1)));

    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    expect(dest.routes).toHaveLength(1);
    expect(dest.routes[0]!.neighbour.equals(NbrA)).toBe(true);
  });
});

describe("Inp3 ingest — coexistence with quality routes", () => {
  it("inp3 ingestion attaches a time metric to an existing quality route without disturbing it", () => {
    const table = newTable();
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    const qualityOnly = routeVia(table, DestSot, NbrA)!;
    expect(qualityOnly.inp3).toBeUndefined();
    const q = qualityOnly.quality;
    const obs = qualityOnly.obsolescence;

    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    const both = routeVia(table, DestSot, NbrA)!;
    expect(both.quality).toBe(q);
    expect(both.obsolescence).toBe(obs);
    expect(both.inp3).toBeDefined();
    expect(both.inp3!.targetTimeMs).toBe(160);
  });

  it("a nodes refresh does not wipe a coexisting inp3 metric", () => {
    const table = newTable();
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    expect(routeVia(table, DestSot, NbrA)!.inp3).toBeDefined();

    // A later NODES broadcast refreshes the quality — the time metric must survive.
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 100 },
    ]));

    const route = routeVia(table, DestSot, NbrA)!;
    expect(route.inp3).toBeDefined();
    expect(route.inp3!.targetTimeMs).toBe(160);
    expect(route.quality).toBe(combineQuality(100, 192));
  });

  it("a quality route and a distinct time route coexist under one destination", () => {
    const table = newTable();
    // Quality route to SOT via NbrA (NODES); a time route to SOT via NbrB (RIF).
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100)));

    const dest = table
      .snapshot()
      .destinations.find((d) => d.destination.equals(DestSot))!;
    expect(dest.routes).toHaveLength(2);
    const viaA = dest.routes.find((r) => r.neighbour.equals(NbrA))!;
    const viaB = dest.routes.find((r) => r.neighbour.equals(NbrB))!;
    expect(viaA.inp3).toBeUndefined();
    expect(viaA.quality).toBeGreaterThan(0);
    expect(viaB.inp3).toBeDefined();
    expect(viaB.quality).toBe(0);
  });
});
