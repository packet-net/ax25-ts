import type { Callsign } from "../callsign.js";
import type { NetRomPacket } from "./packet.js";
import type { NetRomRoutingSnapshot } from "./routing-table.js";

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

  // 4. Next hop: the destination's best route (routes is best-first) whose neighbour
  //    is not the one it arrived from.
  const dest = packet.network.destination;
  const resolved = routing.destinations.find((d) => d.destination.equals(dest));
  let nextHop: Callsign | null = null;
  if (resolved !== undefined) {
    for (const route of resolved.routes) {
      if (!route.neighbour.equals(receivedFrom)) {
        nextHop = route.neighbour;
        break;
      }
    }
  }

  if (nextHop === null) {
    return { outcome: ForwardOutcome.DropNoRoute, packet, nextHop: null };
  }

  const forwarded: NetRomPacket = {
    ...packet,
    network: { ...packet.network, timeToLive: cappedTtl },
  };
  return { outcome: ForwardOutcome.ForwardTo, packet: forwarded, nextHop };
}
