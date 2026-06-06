import type { Callsign } from "../callsign.js";
import { NETROM_SHIFTED_LENGTH, writeShifted } from "./callsign.js";
import type { NetRomPacket } from "./packet.js";
import type { NetRomRoute, NetRomRoutingSnapshot } from "./routing-table.js";

/**
 * The NET/ROM L3 **forwarding decision** — what a transit node does with a datagram
 * whose destination is *not* itself: drop it, or forward it (with a decremented,
 * capped TTL) to a next-hop neighbour. Pure (no I/O): the connector feeds it the
 * datagram, the neighbour it arrived from, this node's callsign, the routing view,
 * and the TTL cap, then performs the interlink send for a
 * {@link ForwardOutcome.ForwardTo} outcome.
 *
 * Mirrors the C# `Packet.NetRom.NetRomForwarding.Decide` (the runtime reference) and
 * the de-facto LinBPQ `L4Code.c` forward routine: decrement the hop limit and
 * discard at zero; cap the TTL on everything sent; drop a datagram that has looped
 * back to its own origin; resolve the destination's best route whose neighbour is
 * not the one it just arrived from (never bounce it straight back); otherwise
 * forward. The caller has already established the datagram is not addressed to this
 * node (the "for us" check terminates locally before forwarding is considered).
 */
export enum ForwardOutcome {
  /** Forward it (with the rewritten header) to {@link ForwardDecision.nextHop}. */
  ForwardTo = "forward-to",
  /** Drop: the hop limit reached zero. */
  DropTtlExpired = "drop-ttl-expired",
  /** Drop: the datagram's origin is this node — it has looped back. */
  DropLooped = "drop-looped",
  /** Drop: no onward route to the destination (excluding the way it came). */
  DropNoRoute = "drop-no-route",
}

/** The route-selection policy a forwarding node uses when a destination has more than
 *  one kept route. Mirrors the C# `NetRomForwardMode`. */
export enum ForwardMode {
  /** Always the single best route (bounce-back excluded). Deterministic — every
   *  transit datagram for a destination takes the same path. */
  BestRoute = "best-route",
  /** Per-flow quality-weighted spread: every datagram of one L4 circuit hashes to the
   *  same route (so its ordering is preserved), while distinct circuits distribute
   *  across the kept routes in proportion to quality. Stateless. The default. */
  PerFlow = "per-flow",
}

/** The outcome of a forwarding decision. When {@link ForwardOutcome.ForwardTo},
 *  {@link packet} carries the rewritten (TTL-decremented) datagram to send to
 *  {@link nextHop}. */
export interface ForwardDecision {
  readonly outcome: ForwardOutcome;
  readonly packet: NetRomPacket;
  readonly nextHop: Callsign | null;
}

/** True if the decision is to forward. */
export function shouldForward(decision: ForwardDecision): boolean {
  return decision.outcome === ForwardOutcome.ForwardTo;
}

/**
 * Decide what to do with a transit datagram. The caller has already confirmed
 * `packet`'s destination is not `nodeCall`.
 *
 * @param packet The received datagram.
 * @param receivedFrom The neighbour the datagram arrived from (so it is not bounced
 *   straight back to it).
 * @param nodeCall This node's callsign (for the loop guard).
 * @param routing The current routing view.
 * @param maxTimeToLive The TTL cap applied to everything forwarded (the node's
 *   configured initial TTL — BPQ's `L3LIVES`).
 */
export function decideForward(
  packet: NetRomPacket,
  receivedFrom: Callsign,
  nodeCall: Callsign,
  routing: NetRomRoutingSnapshot,
  maxTimeToLive: number,
  mode: ForwardMode = ForwardMode.PerFlow,
): ForwardDecision {
  // 1. Decrement the hop limit; a datagram that arrives at TTL 1 (or 0) is at the
  //    end of its life and must not be forwarded.
  const ttl = packet.network.timeToLive;
  const decremented = ttl === 0 ? 0 : ttl - 1;
  if (decremented === 0) {
    return { outcome: ForwardOutcome.DropTtlExpired, packet, nextHop: null };
  }

  // 2. Cap the TTL on everything sent, so a buggy/hostile peer can't make a frame
  //    circulate longer than this node's own initial TTL.
  const cappedTtl = Math.min(decremented, maxTimeToLive);

  // 3. Loop guard: a datagram whose origin is this node has come back to its start —
  //    forwarding it again just loops.
  if (packet.network.origin.equals(nodeCall)) {
    return { outcome: ForwardOutcome.DropLooped, packet, nextHop: null };
  }

  // 4. Next hop: under the active mode, among the destination's kept routes
  //    (best-first), excluding the one it arrived from.
  const resolved = routing.destinations.find((d) => d.destination.equals(packet.network.destination));
  const nextHop = resolved === undefined ? null : selectNextHop(resolved.routes, receivedFrom, mode, packet);

  if (nextHop === null) {
    return { outcome: ForwardOutcome.DropNoRoute, packet, nextHop: null };
  }

  const forwarded: NetRomPacket = {
    ...packet,
    network: { ...packet.network, timeToLive: cappedTtl },
  };
  return { outcome: ForwardOutcome.ForwardTo, packet: forwarded, nextHop };
}

/** The next-hop neighbour for a destination under the active mode, excluding the
 *  neighbour the datagram arrived from. `routes` is best-first. */
function selectNextHop(
  routes: readonly NetRomRoute[],
  receivedFrom: Callsign,
  mode: ForwardMode,
  packet: NetRomPacket,
): Callsign | null {
  return mode === ForwardMode.PerFlow
    ? selectWeighted(routes, receivedFrom, flowHash(packet))
    : selectBest(routes, receivedFrom);
}

/** The single best usable route — the first in the best-first list that isn't the way
 *  the datagram came. */
function selectBest(routes: readonly NetRomRoute[], receivedFrom: Callsign): Callsign | null {
  for (const route of routes) {
    if (!route.neighbour.equals(receivedFrom)) {
      return route.neighbour;
    }
  }
  return null;
}

/** A per-flow, quality-weighted pick among the eligible routes (not the way it came,
 *  quality > 0): all datagrams of one circuit hash to the same route, while distinct
 *  circuits spread across the kept routes in proportion to quality. Stateless. */
function selectWeighted(routes: readonly NetRomRoute[], receivedFrom: Callsign, flowHashValue: number): Callsign | null {
  let total = 0;
  for (const route of routes) {
    if (!route.neighbour.equals(receivedFrom) && route.quality > 0) {
      total += route.quality;
    }
  }
  if (total === 0) {
    return null;
  }

  let target = flowHashValue % total;
  for (const route of routes) {
    if (route.neighbour.equals(receivedFrom) || route.quality === 0) {
      continue;
    }
    if (target < route.quality) {
      return route.neighbour;
    }
    target -= route.quality;
  }
  return null; // unreachable: total > 0 guarantees a pick
}

/** FNV-1a (32-bit) over the flow key — the L3 origin (AX.25-shifted, 7 octets) + the
 *  L4 circuit index + id — so every datagram of a circuit hashes identically across
 *  its lifetime. Defined byte-for-byte (mod-2^32 via {@link Math.imul}) so the
 *  C#/TS/Rust ports agree. Returns an unsigned 32-bit value. */
function flowHash(packet: NetRomPacket): number {
  const key = new Uint8Array(NETROM_SHIFTED_LENGTH + 2);
  writeShifted(packet.network.origin, key);
  key[NETROM_SHIFTED_LENGTH] = packet.transport.circuitIndex & 0xff;
  key[NETROM_SHIFTED_LENGTH + 1] = packet.transport.circuitId & 0xff;

  let hash = 0x811c9dc5; // FNV-1a offset basis (2166136261)
  for (const b of key) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193); // FNV-1a prime (16777619), mod 2^32
  }
  return hash >>> 0;
}
