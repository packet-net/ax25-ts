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
});
