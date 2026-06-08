import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  decideForward,
  ForwardMode,
  ForwardOutcome,
  type NetRomDestination,
  NetRomOpcode,
  type NetRomPacket,
  type NetRomRoute,
  type NetRomRoutingSnapshot,
  NetRomTransportFlags,
} from "../../src/netrom/index.js";

/**
 * The NET/ROM L3 forwarding decision ({@link decideForward}) — the transit node's
 * verdict on a datagram addressed to someone else: drop (TTL expired / looped / no
 * route) or forward (with a decremented, capped TTL) to a next-hop neighbour. Mirrors
 * the C# `Packet.NetRom.NetRomForwarding.Decide` (the runtime reference) /
 * LinBPQ `L4Code.c`.
 */
const Me = new Callsign("GB7BBB", 0); // the forwarding (transit) node
const Source = new Callsign("GB7AAA", 0); // the datagram's origin
const Dest = new Callsign("GB7CCC", 0); // the destination (not us)
const FromNbr = new Callsign("GB7AAA", 0); // arrived from this neighbour
const OnwardNbr = new Callsign("GB7CCC", 0); // the way onward to Dest
const AltNbr = new Callsign("GB7DDD", 0); // an alternate next hop

function datagram(origin: Callsign, dest: Callsign, timeToLive: number): NetRomPacket {
  return {
    network: { origin, destination: dest, timeToLive },
    transport: {
      circuitIndex: 7,
      circuitId: 9,
      txSequence: 3,
      rxSequence: 4,
      opcode: NetRomOpcode.Information,
      flags: NetRomTransportFlags.None,
    },
    payload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
  };
}

function routesTo(
  dest: Callsign,
  ...routes: Array<{ neighbour: Callsign; quality: number }>
): NetRomRoutingSnapshot {
  // routes passed best-first (decideForward trusts the snapshot's ordering)
  const list: NetRomRoute[] = routes.map((r) => ({
    neighbour: r.neighbour,
    quality: r.quality,
    obsolescence: 6,
  }));
  const destination: NetRomDestination = {
    destination: dest,
    alias: "DEST",
    routes: list,
    bestRoute: list[0] ?? null,
  };
  return { destinations: [destination], neighbours: [], generatedAt: new Date(0) };
}

const noRoutes: NetRomRoutingSnapshot = {
  destinations: [],
  neighbours: [],
  generatedAt: new Date(0),
};

describe("decideForward — NET/ROM L3 forwarding decision", () => {
  it("forwards a transit datagram to the best next hop with the TTL decremented", () => {
    const packet = datagram(Source, Dest, 10);
    const decision = decideForward(packet, FromNbr, Me, routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }), 25);

    expect(decision.outcome).toBe(ForwardOutcome.ForwardTo);
    expect(decision.nextHop?.equals(OnwardNbr)).toBe(true);
    expect(decision.packet.network.timeToLive).toBe(9);
    expect(decision.packet.network.origin.equals(Source)).toBe(true);
    expect(decision.packet.network.destination.equals(Dest)).toBe(true);
    expect(decision.packet.transport).toEqual(packet.transport);
    expect([...decision.packet.payload]).toEqual([...packet.payload]);
  });

  it("drops when the TTL reaches zero", () => {
    // arrives at TTL 1 → decrements to 0 → not forwarded
    const decision = decideForward(datagram(Source, Dest, 1), FromNbr, Me, routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }), 25);
    expect(decision.outcome).toBe(ForwardOutcome.DropTtlExpired);
  });

  it("caps the TTL at the configured maximum", () => {
    const decision = decideForward(datagram(Source, Dest, 200), FromNbr, Me, routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }), 25);
    expect(decision.outcome).toBe(ForwardOutcome.ForwardTo);
    expect(decision.packet.network.timeToLive).toBe(25);
  });

  it("drops a datagram that looped back to its origin", () => {
    const decision = decideForward(datagram(Me, Dest, 10), FromNbr, Me, routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }), 25);
    expect(decision.outcome).toBe(ForwardOutcome.DropLooped);
  });

  it("drops when there is no route to the destination", () => {
    const decision = decideForward(datagram(Source, Dest, 10), FromNbr, Me, noRoutes, 25);
    expect(decision.outcome).toBe(ForwardOutcome.DropNoRoute);
  });

  it("does not bounce a datagram back to the neighbour it arrived from", () => {
    // the only route to Dest is back via the neighbour it came from → dropped
    const decision = decideForward(datagram(Source, Dest, 10), FromNbr, Me, routesTo(Dest, { neighbour: FromNbr, quality: 200 }), 25);
    expect(decision.outcome).toBe(ForwardOutcome.DropNoRoute);
  });

  it("prefers an alternate route when the best is the way it came", () => {
    const routing = routesTo(Dest, { neighbour: FromNbr, quality: 220 }, { neighbour: AltNbr, quality: 200 });
    const decision = decideForward(datagram(Source, Dest, 10), FromNbr, Me, routing, 25);
    expect(decision.outcome).toBe(ForwardOutcome.ForwardTo);
    expect(decision.nextHop?.equals(AltNbr)).toBe(true);
  });

  // ─── multi-route load-balancing (per-flow, quality-weighted) ──────────

  // A datagram with a chosen flow key (FlowHash keys on the L3 origin + L4 circuit
  // index/id; vary the index to make distinct flows).
  function flow(origin: Callsign, dest: Callsign, ttl: number, circuitIndex: number): NetRomPacket {
    return {
      network: { origin, destination: dest, timeToLive: ttl },
      transport: { circuitIndex, circuitId: 0, txSequence: 0, rxSequence: 0, opcode: NetRomOpcode.Information, flags: NetRomTransportFlags.None },
      payload: new Uint8Array(0),
    };
  }

  it("per-flow pins a circuit to one route regardless of TTL or sequence", () => {
    const routing = routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }, { neighbour: AltNbr, quality: 200 });
    const a = decideForward(flow(Source, Dest, 20, 5), FromNbr, Me, routing, 25, ForwardMode.PerFlow);
    const b = decideForward(flow(Source, Dest, 9, 5), FromNbr, Me, routing, 25, ForwardMode.PerFlow);
    expect(a.outcome).toBe(ForwardOutcome.ForwardTo);
    expect(a.nextHop?.equals(b.nextHop!)).toBe(true);
  });

  it("per-flow spreads distinct circuits across the kept routes", () => {
    const routing = routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }, { neighbour: AltNbr, quality: 200 });
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const d = decideForward(flow(Source, Dest, 20, i), FromNbr, Me, routing, 25, ForwardMode.PerFlow);
      seen.add(d.nextHop!.toString());
    }
    expect(seen.has(OnwardNbr.toString())).toBe(true);
    expect(seen.has(AltNbr.toString())).toBe(true);
  });

  it("per-flow weights the spread by route quality", () => {
    const routing = routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }, { neighbour: AltNbr, quality: 100 });
    let onward = 0;
    let alt = 0;
    for (let i = 0; i < 256; i++) {
      const d = decideForward(flow(Source, Dest, 20, i), FromNbr, Me, routing, 25, ForwardMode.PerFlow);
      if (d.nextHop?.equals(OnwardNbr)) onward++;
      else if (d.nextHop?.equals(AltNbr)) alt++;
    }
    expect(onward).toBeGreaterThan(0);
    expect(alt).toBeGreaterThan(0);
    expect(onward).toBeGreaterThan(alt); // higher-quality route carries more flows
  });

  it("BestRoute mode ignores the flow and always takes the single best route", () => {
    const routing = routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }, { neighbour: AltNbr, quality: 100 });
    for (let i = 0; i < 20; i++) {
      const d = decideForward(flow(Source, Dest, 20, i), FromNbr, Me, routing, 25, ForwardMode.BestRoute);
      expect(d.nextHop?.equals(OnwardNbr)).toBe(true);
    }
  });

  // ─── INP3 forwarding-by-time (preferInp3Routes) ────────────────────────

  // Routes carrying BOTH a quality metric (NODES) and an INP3 time-route (RIF). Each entry
  // is { neighbour, quality, targetTimeMs, hop }. Quality-first ordering as passed.
  function inp3RoutesTo(
    dest: Callsign,
    ...routes: Array<{ neighbour: Callsign; quality: number; targetTimeMs: number; hop: number }>
  ): NetRomRoutingSnapshot {
    const list: NetRomRoute[] = routes.map((r) => ({
      neighbour: r.neighbour,
      quality: r.quality,
      obsolescence: 6,
      inp3: { targetTimeMs: r.targetTimeMs, hopCount: r.hop },
    }));
    const destination: NetRomDestination = {
      destination: dest,
      alias: "DEST",
      routes: list,
      bestRoute: list[0] ?? null,
    };
    return { destinations: [destination], neighbours: [], generatedAt: new Date(0) };
  }

  it("prefers the lowest-target-time INP3 route, overriding quality and per-flow", () => {
    // OnwardNbr is the best QUALITY route; AltNbr is the fastest by measured TIME. With
    // preferInp3Routes on, every flow forwards over AltNbr (the time winner) — overriding
    // both the quality ranking AND the per-flow spread (time-space forwards the fastest path).
    const routing = inp3RoutesTo(
      Dest,
      { neighbour: OnwardNbr, quality: 200, targetTimeMs: 300, hop: 2 },
      { neighbour: AltNbr, quality: 100, targetTimeMs: 100, hop: 3 },
    );

    for (let i = 0; i < 30; i++) {
      const d = decideForward(flow(Source, Dest, 20, i), FromNbr, Me, routing, 25, ForwardMode.PerFlow, true);
      expect(d.outcome).toBe(ForwardOutcome.ForwardTo);
      expect(d.nextHop?.equals(AltNbr)).toBe(true); // the lowest-target-time INP3 route wins for every flow
    }

    // Knob off ⇒ quality wins, byte-for-byte today (BestRoute picks the highest-quality route).
    const off = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25, ForwardMode.BestRoute);
    expect(off.nextHop?.equals(OnwardNbr)).toBe(true); // preferInp3Routes defaults off — quality decides
  });

  it("preferInp3Routes off ignores the INP3 metric entirely", () => {
    // The degenerate-to-today guard: routes carry INP3 metrics that would change the pick,
    // but with the knob off the metric is never read — the quality route is chosen, identical
    // to a node that never heard of INP3.
    const routing = inp3RoutesTo(
      Dest,
      { neighbour: OnwardNbr, quality: 200, targetTimeMs: 999, hop: 9 },
      { neighbour: AltNbr, quality: 100, targetTimeMs: 1, hop: 1 },
    );

    const off = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25, ForwardMode.BestRoute);
    const defaulted = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25); // preferInp3Routes defaults false

    expect(off.nextHop?.equals(OnwardNbr)).toBe(true); // knob off ⇒ quality wins despite AltNbr's far lower target time
    expect(defaulted.nextHop?.equals(OnwardNbr)).toBe(true); // the parameter defaults to off (byte-for-byte today)
  });

  it("falls back to quality when preferred but no INP3 route exists", () => {
    // preferInp3Routes on, but the destination holds only quality routes (no time-route) →
    // fall back to the quality next-hop, exactly as today.
    const routing = routesTo(Dest, { neighbour: OnwardNbr, quality: 200 }, { neighbour: AltNbr, quality: 100 });

    const d = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25, ForwardMode.BestRoute, true);

    expect(d.nextHop?.equals(OnwardNbr)).toBe(true); // no INP3 route to prefer → quality fallback
  });

  it("excludes the INP3 route that arrived from and takes the next-best time", () => {
    // The fastest INP3 route is back the way it came (split-horizon) → excluded; the next
    // lowest-target-time INP3 route is used instead.
    const routing = inp3RoutesTo(
      Dest,
      { neighbour: FromNbr, quality: 100, targetTimeMs: 50, hop: 1 },
      { neighbour: OnwardNbr, quality: 200, targetTimeMs: 300, hop: 2 },
    );

    const d = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25, ForwardMode.PerFlow, true);

    expect(d.nextHop?.equals(OnwardNbr)).toBe(true); // the time winner is the way it came → use the next-best INP3 route
  });

  it("falls back to quality when the only INP3 route is the way it came", () => {
    // The single INP3 route is back the way it came (excluded); a quality-only alternate
    // exists → fall back to it rather than dropping.
    const routing: NetRomRoutingSnapshot = {
      destinations: [
        {
          destination: Dest,
          alias: "DEST",
          routes: [
            { neighbour: FromNbr, quality: 100, obsolescence: 6, inp3: { targetTimeMs: 50, hopCount: 1 } }, // INP3, but the way it came
            { neighbour: AltNbr, quality: 200, obsolescence: 6 }, // quality-only alternate
          ],
          bestRoute: { neighbour: FromNbr, quality: 100, obsolescence: 6, inp3: { targetTimeMs: 50, hopCount: 1 } },
        },
      ],
      neighbours: [],
      generatedAt: new Date(0),
    };

    const d = decideForward(datagram(Source, Dest, 20), FromNbr, Me, routing, 25, ForwardMode.BestRoute, true);

    expect(d.nextHop?.equals(AltNbr)).toBe(true); // no usable INP3 route (the only one is the way it came) → quality fallback
  });

  it("INP3 tie-break is target-time, then hop, then callsign", () => {
    // Two INP3 routes at the same target time: the lower hop count wins (then, on a hop tie,
    // the lower neighbour callsign ordinal — mirroring Inp3RouteSelector).
    const byHop = inp3RoutesTo(
      Dest,
      { neighbour: AltNbr, quality: 200, targetTimeMs: 100, hop: 3 },
      { neighbour: OnwardNbr, quality: 100, targetTimeMs: 100, hop: 2 },
    );
    expect(
      decideForward(datagram(Source, Dest, 20), FromNbr, Me, byHop, 25, ForwardMode.PerFlow, true).nextHop?.equals(
        OnwardNbr,
      ),
    ).toBe(true); // equal target time → fewer hops wins

    // GB7CCC (OnwardNbr) < GB7DDD (AltNbr) ordinally, equal time + hop → callsign tie-break.
    const byCall = inp3RoutesTo(
      Dest,
      { neighbour: AltNbr, quality: 200, targetTimeMs: 100, hop: 2 },
      { neighbour: OnwardNbr, quality: 100, targetTimeMs: 100, hop: 2 },
    );
    expect(
      decideForward(datagram(Source, Dest, 20), FromNbr, Me, byCall, 25, ForwardMode.PerFlow, true).nextHop?.equals(
        OnwardNbr,
      ),
    ).toBe(true); // equal target time + hop → lower callsign ordinal wins
  });
});
