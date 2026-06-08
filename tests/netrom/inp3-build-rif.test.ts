/**
 * Tests for INP3 RIF **emission** ({@link NetRomRoutingTable.buildRif}) — the
 * poison-reversed, per-target-neighbour RIF the node advertises (the time-space
 * analogue of {@link NetRomRoutingTable.buildAdvertisement}). The locked emission
 * rules are `docs/netrom-inp3-i4-design.md` §1 (content) / §2 (poison-reverse):
 * own node at 0/0 first and never poisoned; a destination is advertised iff we HOLD
 * an INP3 time-route for it (at our best held target time — independent of the local
 * forwarding preference); but a destination reached through the target neighbour via
 * *any* kept route is advertised back at the 600 s horizon (the poison), covering the
 * whole multi-route forwarding set so a two-hop loop can never form; alias TLVs gated off.
 *
 * TS port of `tests/Packet.NetRom.Tests/Routing/Inp3BuildRifTests.cs`. Same cases,
 * same assertions, same boundary values.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NETROM_ROUTING_DEFAULTS,
  NetRomRoutingTable,
  type NetRomRoutingOptions,
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
const NbrA = new Callsign("GB7RDG", 0); // a neighbour
const NbrB = new Callsign("GB7XYZ", 0); // a second neighbour
const DestSot = new Callsign("GB7SOT", 0);
const DestMnc = new Callsign("GB7MNC", 0);

const FIXED_NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08T12:00:00Z

function newTable(
  options: NetRomRoutingOptions = NETROM_ROUTING_DEFAULTS,
): NetRomRoutingTable {
  return new NetRomRoutingTable(options, () => FIXED_NOW);
}

function rip(destination: Callsign, hopCount: number, targetTimeMs: number): Inp3Rip {
  return { destination, hopCount, targetTimeMs, tlvs: [] };
}

function rif(...rips: Inp3Rip[]): Inp3Rif {
  return { rips };
}

function ripFor(rif: Inp3Rif, dest: Callsign): Inp3Rip {
  const matches = rif.rips.filter((r) => r.destination.equals(dest));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function nodes(senderAlias: string, entries: NodesEntrySpec[] = []) {
  const bc = parseNodesBroadcast(buildNodesInfo(senderAlias, entries));
  expect(bc).not.toBeNull();
  return bc!;
}

describe("Inp3 buildRif — own-node source RIP (invariant Source)", () => {
  it("empty table emits just the own-node rip at zero/zero", () => {
    const table = newTable();

    const rifOut = table.buildRif(Me, NbrA);

    expect(rifOut.rips).toHaveLength(1);
    const own = rifOut.rips[0]!;
    expect(own.destination.equals(Me)).toBe(true);
    expect(own.targetTimeMs).toBe(0); // the cost to reach us from us is zero
    expect(own.hopCount).toBe(0); // in zero hops
    expect(own.tlvs).toHaveLength(0); // alias TLV emission gated off
    expect(inp3RipIsHorizon(own)).toBe(false); // the source is never poisoned
  });

  it("own-node rip is always first and is zero/zero regardless of table state", () => {
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));
    table.ingestRif(NbrB, Me, 20, rif(rip(DestMnc, 1, 100)));

    for (const toward of [NbrA, NbrB]) {
      const rifOut = table.buildRif(Me, toward);
      expect(rifOut.rips[0]!.destination.equals(Me)).toBe(true);
      expect(rifOut.rips[0]!.targetTimeMs).toBe(0);
      expect(rifOut.rips[0]!.hopCount).toBe(0);
      expect(rifOut.rips.filter((r) => r.destination.equals(Me))).toHaveLength(1);
    }
  });

  it("a rif built toward us never poisons our own node", () => {
    // Degenerate: building toward ourselves (the loop-guard identity == target neighbour).
    const table = newTable();
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    const rifOut = table.buildRif(Me, Me);

    const own = rifOut.rips.filter((r) => r.destination.equals(Me));
    expect(own).toHaveLength(1);
    expect(own[0]!.targetTimeMs).toBe(0);
    expect(inp3RipIsHorizon(own[0]!)).toBe(false);
  });
});

describe("Inp3 buildRif — content (§1.1)", () => {
  it("each selected inp3 route becomes one destination rip at its quantised target time", () => {
    const table = newTable();
    // 100 + 73 + 10 = 183 ms stored; emitted floored to the 10 ms wire granule → 180.
    table.ingestRif(NbrA, Me, 73, rif(rip(DestSot, 1, 100)));

    const rifOut = table.buildRif(Me, NbrB); // toward a DIFFERENT neighbour → no poison

    const r = ripFor(rifOut, DestSot);
    expect(r.targetTimeMs).toBe(180); // 183 ms stored, quantised down
    expect(r.hopCount).toBe(2); // peer 1 + 1 through us
    expect(r.tlvs).toHaveLength(0); // no alias TLV (gated off)
    expect(inp3RipIsHorizon(r)).toBe(false);
  });

  it("a quality-only destination is not in the rif", () => {
    const table = newTable();
    // A NODES quality route only — no INP3 time-route — must not appear in the RIF.
    table.ingest(NbrA, Me, "vhf", nodes("RDG", [
      { dest: DestSot, destAlias: "SOT", neighbour: NbrA, quality: 200 },
    ]));

    const rifOut = table.buildRif(Me, NbrB);

    expect(rifOut.rips).toHaveLength(1);
    expect(rifOut.rips[0]!.destination.equals(Me)).toBe(true);
  });

  it("destination rips are ordered by ascending target time then callsign after the own-node rip", () => {
    const table = newTable();
    // Two destinations, faster via the same neighbour so neither is poisoned toward NbrB.
    table.ingestRif(NbrA, Me, 200, rif(rip(DestSot, 1, 100))); // 310
    table.ingestRif(NbrA, Me, 20, rif(rip(DestMnc, 1, 100))); // 130

    const rifOut = table.buildRif(Me, NbrB);

    expect(rifOut.rips[0]!.destination.equals(Me)).toBe(true); // own-node RIP first
    expect(rifOut.rips[1]!.destination.equals(DestMnc)).toBe(true); // lowest (130) first
    expect(rifOut.rips[2]!.destination.equals(DestSot)).toBe(true); // then the slower (310)
  });
});

describe("Inp3 buildRif — poison-reverse (invariant P)", () => {
  it("a dest via N is poisoned at the horizon in the rif toward N", () => {
    const table = newTable();
    // SOT is reached via NbrA. The RIF toward NbrA must poison SOT.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    const towardA = table.buildRif(Me, NbrA);

    const r = ripFor(towardA, DestSot);
    expect(r.targetTimeMs).toBe(INP3_HORIZON_MS);
    expect(inp3RipIsHorizon(r)).toBe(true);
  });

  it("the same dest is finite in the rif toward a different neighbour", () => {
    const table = newTable();
    // SOT via NbrA: poisoned toward NbrA, but advertised at its real time toward NbrB.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100)));

    const towardA = table.buildRif(Me, NbrA);
    const towardB = table.buildRif(Me, NbrB);

    expect(ripFor(towardA, DestSot).targetTimeMs).toBe(INP3_HORIZON_MS);
    expect(ripFor(towardB, DestSot).targetTimeMs).toBe(160); // 100+50+10
    expect(inp3RipIsHorizon(ripFor(towardB, DestSot))).toBe(false);
  });

  it("poison reverse covers every kept next hop not just the best", () => {
    const table = newTable();
    // SOT reachable via BOTH neighbours. The shipped multi-route LB forwards SOT
    // traffic over BOTH, so advertising SOT back at a finite metric to EITHER seeds
    // a loop — both must be poisoned, not just the faster/best one.
    table.ingestRif(NbrA, Me, 200, rif(rip(DestSot, 1, 100))); // 310 via NbrA
    table.ingestRif(NbrB, Me, 20, rif(rip(DestSot, 1, 100))); // 130 via NbrB

    expect(inp3RipIsHorizon(ripFor(table.buildRif(Me, NbrA), DestSot))).toBe(true);
    expect(inp3RipIsHorizon(ripFor(table.buildRif(Me, NbrB), DestSot))).toBe(true);

    // Toward a neighbour that is NOT one of SOT's next hops, advertise the best (130) finite.
    const r = ripFor(table.buildRif(Me, new Callsign("GB7ZZZ", 0)), DestSot);
    expect(inp3RipIsHorizon(r)).toBe(false);
    expect(r.targetTimeMs).toBe(130);
  });
});

describe("Inp3 buildRif — invariant (P'): never finite back to a route's own next hop", () => {
  it("emitter never advertises a finite metric back to a route's own next hop", () => {
    // A spread of destinations, each selected via one of two neighbours. For EVERY
    // neighbour N and EVERY destination D whose selected next hop is N, the RIF
    // toward N must carry D at the horizon — the operational restatement of (P).
    const table = newTable();
    const n1 = new Callsign("GB7AAA", 0);
    const n2 = new Callsign("GB7BBB", 0);
    const d1 = new Callsign("GB7DDD", 0);
    const d2 = new Callsign("GB7EEE", 0);
    const d3 = new Callsign("GB7FFF", 0);

    table.ingestRif(n1, Me, 10, rif(rip(d1, 1, 100))); // d1 via n1
    table.ingestRif(n2, Me, 10, rif(rip(d2, 1, 100))); // d2 via n2
    table.ingestRif(n1, Me, 10, rif(rip(d3, 1, 100))); // d3 via n1

    for (const toward of [n1, n2]) {
      const rifOut = table.buildRif(Me, toward);
      for (const r of rifOut.rips) {
        if (r.destination.equals(Me)) {
          expect(inp3RipIsHorizon(r)).toBe(false); // own-node never poisoned
          continue;
        }

        // (D reached via toward through ANY kept route) ⟹ horizon — split-horizon
        // over the full forwarding next-hop set, not just the best route.
        const dest = table
          .snapshot()
          .destinations.find((x) => x.destination.equals(r.destination))!;
        if (dest.routes.some((rt) => rt.neighbour.equals(toward))) {
          expect(r.targetTimeMs).toBe(INP3_HORIZON_MS);
        } else {
          expect(inp3RipIsHorizon(r)).toBe(false);
        }
      }
    }
  });
});

describe("Inp3 buildRif — emission is holding-based, independent of forwarding preference", () => {
  it("a held inp3 route is advertised regardless of the forwarding preference", () => {
    const table = newTable();
    // Emission advertises every destination we HOLD an INP3 time-route for, so
    // neighbours learn the time topology — even on a node that forwards by quality.
    table.ingestRif(NbrA, Me, 50, rif(rip(DestSot, 1, 100))); // 160 via NbrA

    const rifOut = table.buildRif(Me, NbrB); // toward a different neighbour → finite

    const r = ripFor(rifOut, DestSot);
    expect(r.destination.equals(DestSot)).toBe(true);
    expect(inp3RipIsHorizon(r)).toBe(false);
    expect(r.targetTimeMs).toBe(160);
  });
});
