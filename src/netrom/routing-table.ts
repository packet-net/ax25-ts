import type { Callsign } from "../callsign.js";
import {
  NETROM_QUALITY_MAX,
  NETROM_QUALITY_MIN,
  combineQuality,
} from "./quality.js";
import type { NodesBroadcastEntry } from "./nodes-broadcast-builder.js";
import type { NodesBroadcast } from "./nodes-broadcast.js";
import {
  INP3_HORIZON_MS,
  inp3RipAlias,
  inp3RipIsHorizon,
  type Inp3Rif,
  type Inp3Rip,
} from "./inp3-rif.js";
import { SNTT_UNSET } from "./inp3-sntt.js";

/**
 * The configurable knobs of NET/ROM route maintenance. These exist because
 * **NET/ROM has no single normative standard** — the canonical appendix names
 * defaults (OBSINIT 6, three routes per destination), but real nodes set the
 * quality floors and table caps differently (BPQ's per-port MINQUAL, XRouter's
 * deliberately-lower qualities), and quality-floor drift is the perennial
 * NET/ROM interop pain. We keep the canonical defaults and expose every
 * divergence as a named knob, rather than baking any one node's choices in.
 *
 * Defaults are the canonical-appendix values where one exists, and the most
 * widely-interoperable de-facto value otherwise. All are read-only-ingest
 * concerns: a higher floor simply means we *learn* fewer routes; nothing here
 * transmits.
 *
 * Mirrors `Packet.NetRom.Routing.NetRomRoutingOptions` on the C# side.
 */
export interface NetRomRoutingOptions {
  /**
   * The path quality assumed for a directly-heard neighbour we have no
   * configured link quality for — the quality of the assumed direct route to a
   * broadcast's originator. Canonical default-port path quality is **192** (a
   * common direct-link convention; the appendix's worked examples and BPQ both
   * sit in the 192–203 band).
   */
  defaultNeighbourQuality: number;
  /**
   * The worst quality a route may have and still be kept (MINQUAL). A derived
   * route quality below this is dropped. Canonical floor is **0** (keep
   * everything above zero); operators commonly raise it to 128/150/180 to reject
   * mislabelled-neighbour qualities, so it is a knob. A quality-0 route is always
   * dropped regardless (the trivial-loop guard and the "never usable" rule),
   * independent of this floor.
   */
  minQuality: number;
  /**
   * The obsolescence count a route is (re)initialised to when a broadcast
   * adds/refreshes it (OBSINIT). The table is swept at the broadcast interval,
   * decrementing every route's count; at 0 the route is purged. Canonical
   * default **6**.
   */
  obsoleteInitial: number;
  /**
   * The obsolescence advertise-gate (BPQ's OBSMIN): a route whose obsolescence
   * has decayed *below* this is still kept + usable but is no longer included in
   * our outgoing NODES broadcasts ({@link NetRomRoutingTable.buildAdvertisement})
   * — so a fading route stops being advertised before it is finally purged at 0.
   * Canonical / BPQ default **4**; a value ≤ 1 advertises every kept route. Only
   * consulted on the origination (TX) side; ingest never reads it.
   */
  obsoleteMinimum: number;
  /**
   * Maximum routes retained per destination (sorted by quality, best first).
   * Canonical default **3**.
   */
  maxRoutesPerDestination: number;
  /**
   * Upper bound on the number of distinct destinations the table will hold — a
   * memory-safety cap against an unbounded destination list on a busy network
   * (BPQ's MAXNODES). Once reached, broadcasts advertising a brand-new
   * destination are ignored (existing destinations still update). Default
   * **1024**, generous for read-only ingest.
   */
  maxDestinations: number;
}

/** The canonical defaults (OBSINIT 6, OBSMIN 4, default-port quality 192, 3 routes/dest). */
export const NETROM_ROUTING_DEFAULTS: NetRomRoutingOptions = {
  defaultNeighbourQuality: 192,
  minQuality: 0,
  obsoleteInitial: 6,
  obsoleteMinimum: 4,
  maxRoutesPerDestination: 3,
  maxDestinations: 1024,
};

/**
 * The INP3 measured-time metric carried alongside a route's quality (slice I-3):
 * the local target time to the destination via this route (Σ SNTT along the path,
 * in ms) and the hop count. A route may hold this in addition to its NODES quality,
 * so a destination coexists in both metric spaces. Absent (`undefined`) on a
 * pure quality (NODES) route.
 *
 * Mirrors `Packet.NetRom.Routing.Inp3RouteMetric` on the C# side.
 */
export interface Inp3RouteMetric {
  /** Local target time to the destination via this route, in ms (≤ 600000 = horizon). */
  readonly targetTimeMs: number;
  /** Hop count to the destination via this route. */
  readonly hopCount: number;
}

/**
 * One learned route to a NET/ROM destination: the next-hop neighbour to forward
 * through, the quality we derived for it, and its obsolescence count. Immutable
 * — a member of a {@link NetRomDestination} in a {@link NetRomRoutingSnapshot}.
 *
 * Mirrors `Packet.NetRom.Routing.NetRomRoute` on the C# side.
 */
export interface NetRomRoute {
  /** The neighbour we forward through for this route. */
  readonly neighbour: Callsign;
  /** Our derived quality for this route (0..255), best first within a destination. */
  readonly quality: number;
  /** Obsolescence count; decremented each sweep, purged at 0. */
  readonly obsolescence: number;
  /**
   * The INP3 measured-time metric for this route, when one has been learned via a
   * RIF (slice I-3). `undefined` on a pure NODES quality route. A route holding this
   * participates in the INP3 time-space (selection / forwarding-by-time / RIF
   * re-advertisement) as well as the quality space.
   */
  readonly inp3?: Inp3RouteMetric;
}

/**
 * A destination known to the table — its callsign + alias and its kept routes
 * (≤ {@link NetRomRoutingOptions.maxRoutesPerDestination}, sorted by quality,
 * best first). The active route is {@link bestRoute}.
 *
 * Mirrors `Packet.NetRom.Routing.NetRomDestination` on the C# side.
 */
export interface NetRomDestination {
  /** The destination node's callsign. */
  readonly destination: Callsign;
  /** The destination node's alias / mnemonic (may be empty). */
  readonly alias: string;
  /** The kept routes, best quality first. */
  readonly routes: readonly NetRomRoute[];
  /** The highest-quality route to this destination, or `null` if it somehow has none. */
  readonly bestRoute: NetRomRoute | null;
}

/**
 * A directly-heard NET/ROM neighbour — a node whose NODES broadcast we received
 * firsthand, with the path quality we assume to it and the port we heard it on.
 * Mirrors the canonical neighbour list (the `ROUTES` command), restricted to
 * what read-only ingest can know (we don't probe links, so quality is the
 * assumed default-port quality, and there are no digipeaters or lock state).
 *
 * Mirrors `Packet.NetRom.Routing.NetRomNeighbour` on the C# side.
 */
export interface NetRomNeighbour {
  /** The neighbour's callsign. */
  readonly neighbour: Callsign;
  /** The neighbour's alias / mnemonic, as it announced (may be empty). */
  readonly alias: string;
  /** The listener port id we heard it on. */
  readonly portId: string;
  /** The path quality we assume to this neighbour (0..255). */
  readonly pathQuality: number;
  /** When we last heard a broadcast from it (epoch ms). */
  readonly lastHeard: number;
}

/**
 * An immutable, point-in-time view of the learned NET/ROM routing table —
 * destinations with their routes, and the directly-heard neighbours. This is the
 * read-only model the {@link NetRomService.snapshot} API hands out for surfacing
 * (the `Nodes`-command analogue, a future monitor UI, …).
 *
 * Mirrors `Packet.NetRom.Routing.NetRomRoutingSnapshot` on the C# side.
 */
export interface NetRomRoutingSnapshot {
  /** Known destinations (ordering: alias/callsign, ascending). */
  readonly destinations: readonly NetRomDestination[];
  /** Directly-heard neighbours (ordering: callsign, ascending). */
  readonly neighbours: readonly NetRomNeighbour[];
  /** When this snapshot was taken (epoch ms). */
  readonly generatedAt: number;
}

/** An empty snapshot (nothing learned yet). */
export const EMPTY_NETROM_SNAPSHOT: NetRomRoutingSnapshot = {
  destinations: [],
  neighbours: [],
  generatedAt: 0,
};

/**
 * Resolve a connect target — an *alias* (e.g. `SOT`) or a *callsign* (e.g.
 * `GB7SOT`, with or without SSID) — against a {@link NetRomRoutingSnapshot} to the
 * known destination, or `null` if the table has no route to it. Alias match is
 * preferred (the human-friendly name a user types) and case-insensitive; the
 * callsign fallback is a case-insensitive text match. This is what
 * `connect <alias>` consults to find the best next hop across the network.
 *
 * Mirrors `NetRomRoutingSnapshot.ResolveDestination` on the C# side. (The C# method
 * lives on the snapshot record; the TS snapshot is a plain interface, so this is a
 * free function over it — the project's "model is data, behaviour is functions"
 * idiom, the same shape as the wire codecs.)
 */
export function resolveDestination(
  snapshot: NetRomRoutingSnapshot,
  aliasOrCallsign: string,
): NetRomDestination | null {
  const needle = aliasOrCallsign.trim();
  if (needle === "") {
    return null;
  }
  const upper = needle.toUpperCase();

  // Prefer an exact alias match (case-insensitive).
  for (const d of snapshot.destinations) {
    if (d.alias !== "" && d.alias.toUpperCase() === upper) {
      return d;
    }
  }
  // Else a callsign match (case-insensitive text, e.g. GB7SOT or GB7SOT-2).
  for (const d of snapshot.destinations) {
    if (d.destination.toString().toUpperCase() === upper) {
      return d;
    }
  }
  return null;
}

/**
 * The directly-heard neighbour entry for `neighbour` in `snapshot`, or `null` if it
 * is not a known neighbour. Used to find the port an interlink to that neighbour
 * should run on.
 *
 * Mirrors `NetRomRoutingSnapshot.NeighbourFor` on the C# side.
 */
export function neighbourFor(
  snapshot: NetRomRoutingSnapshot,
  neighbour: Callsign,
): NetRomNeighbour | null {
  for (const n of snapshot.neighbours) {
    if (n.neighbour.equals(neighbour)) {
      return n;
    }
  }
  return null;
}

// ─── Mutable internal state (private to the table) ──────────────────────────

interface RouteState {
  neighbour: Callsign;
  quality: number;
  obsolescence: number;
  /**
   * The optional INP3 metric (measured target time + hop count) learned from a
   * RIF, or `undefined` if this route was only ever learned from NODES. The
   * second metric space (lowest-time-best), independent of {@link quality}: one
   * route can carry both. Cleared on a horizon withdrawal without disturbing the
   * quality metric. Mirrors the C# `RouteState.Inp3`.
   */
  inp3?: Inp3RouteMetric;
}

interface DestinationState {
  alias: string;
  // keyed by via-neighbour callsign string
  routes: Map<string, RouteState>;
}

interface NeighbourState {
  alias: string;
  portId: string;
  pathQuality: number;
  lastHeard: number;
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return NETROM_QUALITY_MIN;
  return Math.max(NETROM_QUALITY_MIN, Math.min(NETROM_QUALITY_MAX, Math.trunc(value)));
}

/**
 * The learned NET/ROM routing table: ingests NODES broadcasts heard
 * promiscuously, derives route qualities via the multiplicative per-hop formula,
 * keeps the best routes per destination with obsolescence decay, and hands out
 * immutable {@link NetRomRoutingSnapshot}s for surfacing.
 *
 * **Read-only by construction.** The table is a pure consumer of heard
 * broadcasts — it transmits nothing, originates no NODES, opens no circuits. It
 * implements the canonical processing heuristics from the NET/ROM appendix:
 *
 * 1. A heard broadcast's originator becomes a directly-heard *neighbour*,
 *    created with the configured default-port path quality if not already known
 *    (heuristic 3 + 4).
 * 2. A **direct route to the originator** is assumed at the neighbour's path
 *    quality (heuristic 4).
 * 3. For each advertised destination, the route quality *via that neighbour* is
 *    the advertised quality combined with the path quality
 *    ({@link combineQuality}, heuristic 5).
 * 4. **Trivial-loop guard**: if the advertised best-neighbour is our own
 *    callsign, the route is quality 0 — a last resort that is never kept
 *    (heuristic 6).
 * 5. Only the {@link NetRomRoutingOptions.maxRoutesPerDestination} best routes
 *    per destination are kept (heuristic 7).
 * 6. Routes at or below quality 0, or below
 *    {@link NetRomRoutingOptions.minQuality}, are dropped (heuristic 8).
 * 7. Destinations stop being added once
 *    {@link NetRomRoutingOptions.maxDestinations} is reached (heuristic 9).
 *
 * **Obsolescence.** A route's count is (re)set to
 * {@link NetRomRoutingOptions.obsoleteInitial} whenever a broadcast
 * adds/refreshes it. {@link sweep} (called at the broadcast interval) decrements
 * every count and purges routes that reach 0; a destination with no remaining
 * routes is removed.
 *
 * **No locking.** Unlike the C# `NetRomRoutingTable` (which gates every
 * mutation/snapshot under a single lock because `FrameTraced` fires on listener
 * pump threads), JavaScript's single-threaded event loop means a snapshot built
 * synchronously can never observe a torn state — there is no concurrent mutation
 * to guard against. The `now` clock is injected (the TS analogue of the C#
 * `TimeProvider`) so last-heard stamps and obsolescence decay are deterministic
 * under test.
 *
 * Mirrors `Packet.NetRom.Routing.NetRomRoutingTable` on the C# side.
 */
export class NetRomRoutingTable {
  /**
   * The fixed INP3 per-hop target-time increment, in milliseconds (design §2.2).
   * Added to every learned time-route so target time is strictly increasing per
   * hop even across a ~0 ms link (a loopback or same-host fleet) — the loop-safety
   * invariant "target time monotonic-nondecreasing per hop". Mirrors the C#
   * `NetRomRoutingTable.PerHopIncrementMs`.
   */
  static readonly PER_HOP_INCREMENT_MS = 10;

  /**
   * The default INP3 hop horizon (canonical 30): a RIP whose learned hop count
   * would exceed this is not learned. The hop-count analogue of the 600 s time
   * horizon. Used when {@link ingestRif} is called without an explicit limit (the
   * host passes its configured hop limit). Mirrors the C#
   * `NetRomRoutingTable.DefaultHopLimit`.
   */
  static readonly DEFAULT_HOP_LIMIT = 30;

  private readonly options: NetRomRoutingOptions;
  private readonly now: () => number;

  // destination callsign string -> its entry (alias + per-neighbour routes).
  private readonly destinations = new Map<string, DestinationState>();
  // neighbour callsign string -> directly-heard neighbour state.
  private readonly neighbours = new Map<string, NeighbourState>();
  // destination/neighbour callsign string -> the Callsign object (for snapshot reconstruction).
  private readonly callsignByKey = new Map<string, Callsign>();

  // INP3 invariant (W): destinations that have lost their LAST Inp3-bearing route
  // (withdrawn at horizon, dropped by markNeighbourDown, or aged out by sweep)
  // since the host last DRAINED this set. The host drainRecentlyWithdrawn()s it
  // ONCE at the start of each fan-out round (snapshot+clear) and hands the
  // snapshot to every neighbour's buildRif, so the one-shot horizon RIP reaches
  // each neighbour exactly once. Populated ONLY when an Inp3-bearing route fully
  // leaves — so a vanilla (quality-only) markNeighbourDown / sweep, the INP3-off
  // path, never touches it (the default-off guarantee, design §7.1).
  // recentlyWithdrawn() is a read-only peek (tests / monitoring); the host never
  // reads it directly — only drainRecentlyWithdrawn(). Keyed by callsign string
  // with the Callsign object retained for snapshot reconstruction.
  private readonly recentlyWithdrawnSet = new Map<string, Callsign>();

  /**
   * @param options Route-maintenance knobs. Defaults to
   *   {@link NETROM_ROUTING_DEFAULTS}.
   * @param now Injected clock returning epoch ms (last-heard stamps). Defaults
   *   to `Date.now`.
   */
  constructor(
    options: NetRomRoutingOptions = NETROM_ROUTING_DEFAULTS,
    now: () => number = Date.now,
  ) {
    this.options = options;
    this.now = now;
  }

  /**
   * Ingest a NODES broadcast heard from `originator` on `portId`, with this
   * node's own callsign `myCall` (for the trivial-loop guard). Pure table
   * maintenance — never transmits.
   *
   * @param originator The AX.25 source callsign of the UI frame (the broadcasting neighbour).
   * @param myCall Our own node callsign — an advertised best-neighbour matching this is loop-guarded to quality 0.
   * @param portId The listener port id the broadcast was heard on.
   * @param broadcast The parsed broadcast content.
   */
  ingest(
    originator: Callsign,
    myCall: Callsign,
    portId: string,
    broadcast: NodesBroadcast,
  ): void {
    const now = this.now();
    const pathQuality = clampQuality(this.options.defaultNeighbourQuality);
    const originatorKey = originator.toString();
    this.callsignByKey.set(originatorKey, originator);

    // Heuristic 3: ensure a neighbour-list entry for the originator, created with
    // the default-port path quality. Refresh its alias + last-heard each time.
    let nbr = this.neighbours.get(originatorKey);
    if (!nbr) {
      nbr = { alias: "", portId, pathQuality, lastHeard: now };
      this.neighbours.set(originatorKey, nbr);
    }
    nbr.alias = broadcast.senderAlias;
    nbr.portId = portId;
    nbr.lastHeard = now;
    const originatorPathQuality = nbr.pathQuality;

    // Heuristic 4: assume a direct route to the originator at the neighbour path
    // quality. (The originator may also appear as a destination in its own list
    // with a different quality — that is merged as a normal indirect route below;
    // the direct route via itself usually wins.)
    this.upsertRoute(originator, broadcast.senderAlias, originator, originatorPathQuality);

    // Heuristic 5/6/7/8: each advertised destination becomes a route via this
    // neighbour at the combined quality, loop-guarded against us.
    for (const entry of broadcast.entries) {
      const quality = entry.bestNeighbour.equals(myCall)
        ? NETROM_QUALITY_MIN // trivial-loop guard
        : combineQuality(entry.bestQuality, originatorPathQuality);

      this.upsertRoute(entry.destination, entry.destinationAlias, originator, quality);
    }
  }

  /**
   * Ingest an INP3 {@link Inp3Rif} heard on a connected interlink from
   * `receivedFromNeighbour`, learning a measured *target-time* route (the second
   * metric space) per RIP. The time-space analogue of {@link ingest}: it mirrors
   * {@link upsertRoute}'s discipline (per-destination route cap, the trivial-loop
   * guard) and is pure table maintenance — it never transmits.
   *
   * **Per-RIP math** (design §2.2 / §5.2). For each RIP, the local INP3 metric for
   * its destination *via `receivedFromNeighbour`* is
   * `localTargetTimeMs = rip.targetTimeMs + neighbourSnttMs + 10` (the peer's
   * advertised target time, plus the measured cost of this link, plus the fixed
   * {@link PER_HOP_INCREMENT_MS} per-hop increment that keeps target time strictly
   * increasing per hop even across a ~0 ms link) and
   * `localHopCount = rip.hopCount + 1`.
   *
   * **Horizon = withdrawal** (design §2.3). If the RIP is at/over the 600 s horizon
   * ({@link inp3RipIsHorizon}), or the computed `localTargetTimeMs` reaches the
   * horizon, the INP3 metric for `(destination via receivedFromNeighbour)` is
   * *withdrawn* — its {@link Inp3RouteMetric} is cleared, leaving any coexisting
   * quality route intact; a route then left with neither a usable quality nor an
   * INP3 metric is removed, and a destination left with no route is removed.
   *
   * **Skips** (no learn, no withdraw). A RIP is skipped when the link cost is not
   * yet measured (`neighbourSnttMs === SNTT_UNSET` — an un-probed link must never
   * *remove* a time-route it never learned), when `localHopCount` exceeds
   * `hopLimit` (the hop horizon), or when the destination is `myCall` (the
   * receive-side trivial-loop guard, mirroring {@link ingest}).
   *
   * **Coexistence (does not disturb quality ingestion).** An INP3 upsert only sets
   * the {@link Inp3RouteMetric} on the `(dest via neighbour)` route, creating the
   * route as a pure time-route (quality 0) if none existed, or attaching the metric
   * to an existing quality route without touching its quality / obsolescence. The
   * per-destination cap evicts by quality (an INP3-only route counts as quality 0
   * for eviction ordering only — design AMBIGUITY-I3-2), so a node that never
   * prefers INP3 routes evicts byte-identically to today.
   *
   * Mirrors `NetRomRoutingTable.IngestRif` on the C# side.
   *
   * @param receivedFromNeighbour The interlink neighbour the RIF arrived on — the
   *   next-hop (via) for every route this RIF teaches.
   * @param myCall Our own node callsign — a RIP whose destination is us is skipped
   *   (the trivial-loop guard).
   * @param neighbourSnttMs The smoothed transport time to `receivedFromNeighbour`
   *   in milliseconds; {@link SNTT_UNSET} (`0xffffffff`) means "no measurement
   *   yet" — every RIP is then skipped (no time-route learned, none withdrawn).
   * @param rif The parsed RIF (the I-1 wire type).
   * @param hopLimit The maximum learned hop count (the hop horizon, canonical 30):
   *   a RIP whose `localHopCount` exceeds this is not learned. Values &lt; 1 are
   *   treated as 1. Defaults to {@link DEFAULT_HOP_LIMIT}.
   */
  ingestRif(
    receivedFromNeighbour: Callsign,
    myCall: Callsign,
    neighbourSnttMs: number,
    rif: Inp3Rif,
    hopLimit: number = NetRomRoutingTable.DEFAULT_HOP_LIMIT,
  ): void {
    const effectiveHopLimit = Math.max(1, hopLimit);

    // An un-probed link has no measured cost — learn no time-route, and
    // (crucially) withdraw none either: an Unset SNTT must never remove a route it
    // never taught.
    const linkMeasured = neighbourSnttMs !== SNTT_UNSET;

    for (const rip of rif.rips) {
      // localTargetTimeMs = peer target + this link's measured cost + per-hop
      // floor. JS numbers are 53-bit floats, so the horizon comparison is
      // overflow-free even at a near-horizon peer target.
      const localTargetTime =
        rip.targetTimeMs +
        neighbourSnttMs +
        NetRomRoutingTable.PER_HOP_INCREMENT_MS;

      // Horizon = withdrawal (clears the INP3 metric only), independent of the
      // SNTT measurement — a peer advertising the horizon withdraws regardless.
      // The computed-over-horizon case only applies once the link is measured (an
      // Unset SNTT would trivially overflow the horizon, which we must NOT treat
      // as a withdrawal — hence the linkMeasured guard on the second clause).
      if (
        inp3RipIsHorizon(rip) ||
        (linkMeasured && localTargetTime >= INP3_HORIZON_MS)
      ) {
        this.withdrawInp3(rip.destination, receivedFromNeighbour);
        continue;
      }

      if (!linkMeasured) {
        continue; // link cost unknown — learn no time-route (and withdrew none)
      }

      const localHopCount = rip.hopCount + 1;
      if (localHopCount > effectiveHopLimit) {
        continue; // hop horizon — path too long to learn
      }

      if (rip.destination.equals(myCall)) {
        continue; // trivial-loop guard: a route to ourselves is never learned
      }

      this.upsertInp3Route(
        rip.destination,
        inp3RipAlias(rip) ?? "",
        receivedFromNeighbour,
        {
          targetTimeMs: localTargetTime,
          hopCount: Math.min(localHopCount, 255),
        },
      );
    }
  }

  /**
   * Decrement the obsolescence count of every route, purging routes that reach 0
   * and destinations that lose all their routes. Call this at the NODES broadcast
   * interval. Neighbours with no surviving route are also dropped.
   *
   * @returns The number of routes purged.
   */
  sweep(): number {
    let purged = 0;
    const emptyDestinations: string[] = [];

    for (const [destKey, dest] of this.destinations) {
      // Did this destination hold an Inp3-bearing route before the sweep? (The
      // predicate is pre-mutation.)
      let hadInp3Before = false;
      for (const route of dest.routes.values()) {
        if (route.inp3 !== undefined) {
          hadInp3Before = true;
          break;
        }
      }

      const survivors = new Map<string, RouteState>();
      let hasInp3After = false;
      for (const [via, route] of dest.routes) {
        const next = route.obsolescence - 1;
        if (next <= 0) {
          purged++;
          continue;
        }
        survivors.set(via, { ...route, obsolescence: next });
        if (route.inp3 !== undefined) {
          hasInp3After = true;
        }
      }
      dest.routes = survivors;
      if (survivors.size === 0) {
        emptyDestinations.push(destKey);
      }

      // Invariant (W): an Inp3-bearing destination whose last time-route aged out
      // this sweep leaves the INP3 space → record the one-shot horizon withdrawal.
      // Guarded on "had an Inp3 route before," so a quality-only sweep (INP3 off)
      // never touches the set (the default-off guard, design §7.1).
      if (hadInp3Before && !hasInp3After) {
        this.recentlyWithdrawnSet.set(destKey, this.callsignByKey.get(destKey)!);
      }
    }

    for (const dc of emptyDestinations) {
      this.destinations.delete(dc);
    }

    this.pruneOrphanNeighbours();
    return purged;
  }

  /**
   * React to a neighbour going down — its interlink could not be raised (it did
   * not answer the connect) or its quality collapsed — by immediately dropping
   * every route that forwards through it, and the neighbour entry itself. This is
   * the explicit link-down failover signal: instead of waiting for the
   * obsolescence {@link sweep} to age the now-dead routes out over the broadcast
   * interval (during which forwarding / connect-routing would keep choosing a
   * route that can't carry traffic), the dead routes leave the table at once, so
   * the very next forward or connect decision fails over to an alternate next hop.
   * A destination that loses all its routes is removed; it and the neighbour
   * re-learn naturally from the next NODES broadcast if the neighbour returns.
   * Idempotent — marking an unknown / already-removed neighbour down is a no-op
   * returning 0. Mirrors C# `NetRomRoutingTable.MarkNeighbourDown`.
   *
   * @returns the number of routes dropped (across all destinations).
   */
  markNeighbourDown(neighbour: Callsign): number {
    const viaKey = neighbour.toString();
    let dropped = 0;
    const emptyDestinations: string[] = [];

    for (const [destKey, dest] of this.destinations) {
      // Note whether the route we are about to drop carried an INP3 metric — only
      // then can dropping it cost the destination its last time-route.
      const removed = dest.routes.get(viaKey);
      const removedRouteHadInp3 = removed?.inp3 !== undefined;

      if (dest.routes.delete(viaKey)) {
        dropped++;
      }
      if (dest.routes.size === 0) {
        emptyDestinations.push(destKey);
      }

      // Invariant (W): a destination that just lost its LAST Inp3-bearing route
      // leaves the INP3 time-space → record it for the one-shot horizon RIP.
      // Guarded on "the removed route carried an Inp3 metric," so a vanilla
      // (quality-only) markNeighbourDown — the L4 dial-failure path that runs with
      // INP3 off — never populates the set (the default-off guard, design §7.1).
      if (removedRouteHadInp3 && !this.hasAnyInp3Route(destKey)) {
        this.recentlyWithdrawnSet.set(destKey, this.callsignByKey.get(destKey)!);
      }
    }

    for (const dc of emptyDestinations) {
      this.destinations.delete(dc);
    }

    this.neighbours.delete(viaKey);
    this.pruneOrphanNeighbours();
    return dropped;
  }

  /**
   * Take an immutable snapshot of the current table — destinations with their
   * best-first routes, and the directly-heard neighbours. Ordering is stable
   * (alias-or-callsign for destinations, callsign for neighbours) so the surfaced
   * output is deterministic.
   */
  snapshot(): NetRomRoutingSnapshot {
    const dests: NetRomDestination[] = [];
    for (const [destKey, dest] of this.destinations) {
      const destination = this.callsignByKey.get(destKey)!;
      const routes = [...dest.routes.values()]
        .sort(
          (a, b) =>
            b.quality - a.quality ||
            compareOrdinal(a.neighbour.toString(), b.neighbour.toString()),
        )
        .slice(0, this.options.maxRoutesPerDestination)
        .map((r) => ({
          neighbour: r.neighbour,
          quality: r.quality,
          obsolescence: r.obsolescence,
          inp3: r.inp3,
        }));

      dests.push({
        destination,
        alias: dest.alias,
        routes,
        bestRoute: routes.length > 0 ? routes[0]! : null,
      });
    }

    dests.sort(
      (a, b) =>
        compareCaseInsensitive(
          a.alias === "" ? a.destination.toString() : a.alias,
          b.alias === "" ? b.destination.toString() : b.alias,
        ) || compareOrdinal(a.destination.toString(), b.destination.toString()),
    );

    const nbrs: NetRomNeighbour[] = [...this.neighbours.entries()]
      .map(([key, n]) => ({
        neighbour: this.callsignByKey.get(key)!,
        alias: n.alias,
        portId: n.portId,
        pathQuality: n.pathQuality,
        lastHeard: n.lastHeard,
      }))
      .sort((a, b) => compareOrdinal(a.neighbour.toString(), b.neighbour.toString()));

    return { destinations: dests, neighbours: nbrs, generatedAt: this.now() };
  }

  /**
   * Build the destination entries to advertise in *our own* NODES broadcast —
   * the L3-origination view of the table, the inverse of {@link ingest}. For
   * each known destination we advertise its best route's quality via its best
   * next-hop neighbour, gated by `obsoleteMinimum` (OBSMIN): a route whose
   * obsolescence has decayed below this is still kept + usable but no longer
   * advertised — it ages out of broadcasts before it is purged. Quality-0 /
   * loop-guarded routes are never advertised.
   *
   * The returned entries are ordered best-quality first (then by destination
   * callsign for stable framing), ready to hand to `buildNodesBroadcast` and
   * emit as UI frames. Read-only with respect to the table — building an
   * advertisement mutates nothing.
   *
   * Mirrors `Packet.NetRom.Routing.NetRomRoutingTable.BuildAdvertisement` on the
   * C# side.
   *
   * @param obsoleteMinimum The OBSMIN advertise-gate (routes with obsolescence
   *   below this are not advertised). Defaults to the table's configured
   *   {@link NetRomRoutingOptions.obsoleteMinimum}; pass `0` to advertise every
   *   kept route.
   * @returns The advertisable entries, best quality first.
   */
  buildAdvertisement(
    obsoleteMinimum: number = this.options.obsoleteMinimum,
  ): NodesBroadcastEntry[] {
    const entries: NodesBroadcastEntry[] = [];
    for (const [destKey, dest] of this.destinations) {
      const destination = this.callsignByKey.get(destKey)!;
      // The best route: highest quality, then highest obsolescence (freshest).
      let best: RouteState | null = null;
      for (const route of dest.routes.values()) {
        if (
          best === null ||
          route.quality > best.quality ||
          (route.quality === best.quality &&
            route.obsolescence > best.obsolescence)
        ) {
          best = route;
        }
      }
      if (best === null) {
        continue;
      }
      if (best.quality <= NETROM_QUALITY_MIN) {
        continue; // never advertise a quality-0 / loop-guarded route
      }
      if (best.obsolescence < obsoleteMinimum) {
        continue; // OBSMIN: decayed below the advertise threshold
      }
      entries.push({
        destination,
        destinationAlias: dest.alias,
        bestNeighbour: best.neighbour,
        quality: best.quality,
      });
    }

    // Best quality first; ties broken by destination callsign (ordinal) so the
    // frame layout is stable / deterministic.
    entries.sort(
      (a, b) =>
        b.quality - a.quality ||
        compareOrdinal(a.destination.toString(), b.destination.toString()),
    );
    return entries;
  }

  /**
   * Build the per-neighbour, poison-reversed INP3 RIF to advertise *toward*
   * `toTargetNeighbour` — the INP3 (measured target-time) analogue of
   * {@link buildAdvertisement} (the quality / NODES view). A pure read; the host
   * calls {@link inp3RifToBytes} on the result and wraps it in a PID-0xCF I-frame
   * on the neighbour's interlink session. Host-free: it takes `myCall` as a
   * parameter (the table never reaches for identity — the same discipline as
   * {@link ingestRif}).
   *
   * The RIF emits, in order (AMBIGUITY-I4-4 — deterministic + cross-stack
   * byte-identical):
   *
   * 1. **Our own node** — exactly one RIP for `myCall` at **target-time 0 ms,
   *    hop 0**, no TLVs. We are the source of ourselves (the cost to reach us from
   *    us is zero, in zero hops). The own-node RIP is **always** present and is
   *    **never poisoned** — it is the source identity, not a learned route (design
   *    §1.1 rule 1, invariant (Source)).
   * 2. **Every destination D (≠ `myCall`) we HOLD an INP3 time-route for** —
   *    independent of any local forwarding preference (a forwarding-by-quality node
   *    still tells its neighbours the time it can reach D in) — ordered by
   *    ascending local target time then destination callsign (ordinal). One RIP
   *    each: hop = our best (lowest-target-time) held route's hop count; target
   *    time = **POISON-REVERSE**: if `toTargetNeighbour` is **any** of D's kept
   *    next hops the RIP is advertised at the {@link INP3_HORIZON_MS} (unreachable
   *    — breaks the would-be two-hop loop over the full multi-route forwarding set,
   *    design §2, invariant (P)); otherwise at the route's real local target time,
   *    quantised down to the 10 ms wire granule. No TLVs (alias emission gated off,
   *    AMBIGUITY-I4-1).
   *
   * Quality-only destinations (no INP3 route) are **not** in the RIF — they are
   * carried by NODES. Finally, one explicit horizon RIP is appended per entry of
   * `recentlyWithdrawn` (minus any re-learned-finite this round, and our own node)
   * so the peer withdraws each immediately rather than waiting for its obsolescence
   * sweep.
   *
   * Mirrors `NetRomRoutingTable.BuildRif` on the C# side.
   *
   * @param myCall Our own node callsign — emitted as the source RIP (0/0, never
   *   poisoned) and the loop-guard identity (a route whose destination is us is
   *   never in the RIF).
   * @param toTargetNeighbour N — the neighbour this RIF is built *for*: any
   *   destination whose kept route is via N is poison-reversed (advertised at the
   *   horizon) in this RIF (design §1.4).
   * @param recentlyWithdrawn The recently-withdrawn snapshot the host
   *   {@link drainRecentlyWithdrawn}ed once at the start of this fan-out round and
   *   passes to every neighbour's RIF — one explicit horizon RIP is appended per
   *   entry (minus any re-learned finite this round, and our own node). Empty / no
   *   argument appends no withdrawal RIPs (the default for callers that don't drive
   *   the withdrawn set, e.g. unit tests of pure poison-reverse).
   * @returns The poison-reversed INP3 RIF to advertise toward `toTargetNeighbour`.
   */
  buildRif(
    myCall: Callsign,
    toTargetNeighbour: Callsign,
    recentlyWithdrawn: readonly Callsign[] = [],
  ): Inp3Rif {
    const myKey = myCall.toString();
    const targetKey = toTargetNeighbour.toString();

    // The destination RIPs, ordered by ascending local target time then callsign
    // (AMBIGUITY-I4-4). We sort by the *real* local target time (stable across the
    // neighbour the RIF is built for), not the poison-overridden value, so the RIP
    // order is identical in every neighbour's RIF given identical state.
    const destRips: { rip: Inp3Rip; localTargetTimeMs: number }[] = [];

    for (const [destKey, dest] of this.destinations) {
      if (destKey === myKey) {
        continue; // our own node is the 0/0 source RIP below, never a learned route.
      }

      // We ADVERTISE a destination iff we HOLD an INP3 time-route for it (design
      // §1) — independent of forwarding preference. Pick our best
      // (lowest-target-time) INP3 route as the advertised metric, and note whether
      // the neighbour we are building toward is ANY of D's kept next hops.
      let bestInp3: Inp3RouteMetric | null = null;
      let poison = false;
      for (const r of dest.routes.values()) {
        if (r.neighbour.toString() === targetKey) {
          poison = true;
        }
        if (
          r.inp3 !== undefined &&
          (bestInp3 === null || r.inp3.targetTimeMs < bestInp3.targetTimeMs)
        ) {
          bestInp3 = r.inp3;
        }
      }

      if (bestInp3 === null) {
        continue; // no INP3 route held → carried by NODES (quality), not the RIF.
      }

      // POISON-REVERSE (design §2, loop-safety): advertise D back at the horizon
      // (unreachable) if the neighbour we are building this RIF for is ANY of D's
      // kept forwarding next hops — not merely D's *best* INP3 next hop. The
      // shipped multi-route load-balancer spreads D's traffic across every kept
      // route, so advertising D back at a finite metric to any neighbour we'd
      // forward D through seeds a two-hop loop. Split-horizon over the full
      // kept-route set is the safe rule.
      const advertisedTargetTimeMs = poison
        ? INP3_HORIZON_MS
        : quantise10(bestInp3.targetTimeMs);

      destRips.push({
        rip: {
          destination: this.callsignByKey.get(destKey)!,
          hopCount: bestInp3.hopCount,
          targetTimeMs: advertisedTargetTimeMs,
          tlvs: [], // alias TLV emission gated OFF (AMBIGUITY-I4-1)
        },
        localTargetTimeMs: bestInp3.targetTimeMs,
      });
    }

    const ordered = destRips
      .sort(
        (a, b) =>
          a.localTargetTimeMs - b.localTargetTimeMs ||
          compareOrdinal(
            a.rip.destination.toString(),
            b.rip.destination.toString(),
          ),
      )
      .map((x) => x.rip);

    // Own-node RIP first (the source seed: 0/0, no TLVs, never poisoned), then the
    // ordered destination RIPs.
    const rips: Inp3Rip[] = [
      {
        destination: myCall,
        hopCount: 0,
        targetTimeMs: 0,
        tlvs: [],
      },
      ...ordered,
    ];

    // Invariant (W): append one explicit horizon RIP per recently-withdrawn
    // destination so the peer withdraws it immediately (rather than waiting for its
    // obsolescence sweep). A destination that was withdrawn-then-relearned in the
    // same round is carried by its FINITE RIP above (it's in `emitted`), not
    // poisoned; and our own node is never withdrawn (the Source invariant).
    if (recentlyWithdrawn.length > 0) {
      const emitted = new Set<string>(
        ordered.map((r) => r.destination.toString()),
      );
      const sortedWithdrawn = [...recentlyWithdrawn].sort((a, b) =>
        compareOrdinal(a.toString(), b.toString()),
      );
      for (const wd of sortedWithdrawn) {
        const wdKey = wd.toString();
        if (wdKey === myKey || emitted.has(wdKey)) {
          continue;
        }
        rips.push({
          destination: wd,
          hopCount: 0,
          targetTimeMs: INP3_HORIZON_MS,
          tlvs: [],
        });
      }
    }

    return { rips };
  }

  /**
   * A read-only **peek** at the recently-withdrawn destinations (INP3 invariant W)
   * — destinations that have lost their last {@link Inp3RouteMetric}-bearing route
   * since the host last {@link drainRecentlyWithdrawn}ed the set. Does **not**
   * clear — for tests and monitoring only. The host never reads this on the
   * fan-out path; it {@link drainRecentlyWithdrawn}s once at the start of a round
   * and hands the snapshot to each neighbour's {@link buildRif}. Stable ordinal
   * ordering for deterministic, cross-stack comparison.
   *
   * Mirrors `NetRomRoutingTable.RecentlyWithdrawn` on the C# side.
   */
  recentlyWithdrawn(): Callsign[] {
    return [...this.recentlyWithdrawnSet.entries()]
      .sort(([a], [b]) => compareOrdinal(a, b))
      .map(([, c]) => c);
  }

  /**
   * Snapshot **and clear** the recently-withdrawn set (INP3 invariant W). The host
   * calls this **once** at the start of a fan-out round and hands the returned
   * snapshot to every neighbour's {@link buildRif} — so the one-shot horizon RIP
   * reaches each neighbour exactly once. Draining (rather than read-then-clear)
   * means a subsequent {@link ingestRif} / {@link markNeighbourDown} /
   * {@link sweep} that withdraws a destination after this call lands in the live
   * set for the NEXT round's drain instead of being cleared unadvertised. Stable
   * ordinal ordering; an empty list when nothing is pending.
   *
   * Mirrors `NetRomRoutingTable.DrainRecentlyWithdrawn` on the C# side.
   */
  drainRecentlyWithdrawn(): Callsign[] {
    const snapshot = this.recentlyWithdrawn();
    this.recentlyWithdrawnSet.clear();
    return snapshot;
  }

  /** Total destinations currently known. */
  get destinationCount(): number {
    return this.destinations.size;
  }

  /** Total directly-heard neighbours currently known. */
  get neighbourCount(): number {
    return this.neighbours.size;
  }

  // ─── Internals ────────────────────────────────────────────────────

  // Add or refresh a route to `destination` via `viaNeighbour`. Applies the
  // quality-0 / MINQUAL floor (heuristic 8), resets obsolescence to OBSINIT,
  // enforces the per-destination route cap (heuristic 7) and the destination cap
  // (heuristic 9).
  private upsertRoute(
    destination: Callsign,
    alias: string,
    viaNeighbour: Callsign,
    quality: number,
  ): void {
    const destKey = destination.toString();
    const viaKey = viaNeighbour.toString();

    // A quality-0 route is never usable / kept; likewise anything under the
    // configured floor. If such a route already existed (from a prior, better
    // advertisement), a now-too-low re-advertisement removes it.
    const acceptable =
      quality > NETROM_QUALITY_MIN && quality >= this.options.minQuality;

    let dest = this.destinations.get(destKey);
    if (!dest) {
      if (!acceptable) {
        return; // nothing to add, nothing to update
      }
      if (this.destinations.size >= this.options.maxDestinations) {
        return; // heuristic 9: destination list full — ignore new destinations
      }
      dest = { alias, routes: new Map() };
      this.destinations.set(destKey, dest);
      this.callsignByKey.set(destKey, destination);
    } else if (alias !== "") {
      // Refresh a known destination's alias when the advertisement carries one.
      dest.alias = alias;
    }

    if (!acceptable) {
      // Drop a route that has decayed below the floor.
      dest.routes.delete(viaKey);
      if (dest.routes.size === 0) {
        this.destinations.delete(destKey);
      }
      return;
    }

    // Preserve any INP3 metric already learned for this (dest via neighbour)
    // route — a NODES quality refresh must not wipe a coexisting time-route (the
    // two metric spaces are independent; see ingestRif). Mirrors the C#
    // `existing?.Inp3` carry-over in `UpsertRoute`.
    const existing = dest.routes.get(viaKey);
    this.callsignByKey.set(viaKey, viaNeighbour);
    dest.routes.set(viaKey, {
      neighbour: viaNeighbour,
      quality,
      obsolescence: this.options.obsoleteInitial,
      inp3: existing?.inp3,
    });

    this.enforceRouteCap(dest);
  }

  // Heuristic 7 (and its INP3 analogue): keep only the N best routes per
  // destination. When the cap is exceeded, evict by the SAME key the quality
  // selection orders by — highest-quality-first, ties by neighbour callsign — so
  // a node that never prefers INP3 routes evicts byte-identically to the
  // quality-only world; an INP3-only route (quality 0) sorts as a quality-0 route
  // for eviction ordering only (design AMBIGUITY-I3-2). The kept route objects are
  // carried verbatim, so a surviving route's INP3 metric is preserved across
  // eviction. Mirrors the C# `EnforceRouteCap`.
  private enforceRouteCap(dest: DestinationState): void {
    if (dest.routes.size <= this.options.maxRoutesPerDestination) {
      return;
    }
    const keep = [...dest.routes.values()]
      .sort(
        (a, b) =>
          b.quality - a.quality ||
          compareOrdinal(a.neighbour.toString(), b.neighbour.toString()),
      )
      .slice(0, this.options.maxRoutesPerDestination);
    const kept = new Map<string, RouteState>();
    for (const r of keep) {
      kept.set(r.neighbour.toString(), r);
    }
    dest.routes = kept;
  }

  // Attach (or refresh) an INP3 time-route metric on the (destination via
  // viaNeighbour) route — the time-space analogue of upsertRoute. If the route
  // already exists (as a quality route, or a prior time-route) the metric is set in
  // place, preserving its quality + obsolescence; if it does not exist the route is
  // created as a pure time-route (quality 0, obsolescence OBSINIT). The per-dest cap
  // is then enforced by the same quality-first eviction key as the quality path
  // (AMBIGUITY-I3-2). Honours the destination cap exactly as upsertRoute does.
  // (Floor/horizon/hop/loop gating is done by ingestRif before here, so this only
  // ever stores a live, finite, in-horizon metric.) Mirrors the C# `UpsertInp3Route`.
  private upsertInp3Route(
    destination: Callsign,
    alias: string,
    viaNeighbour: Callsign,
    metric: Inp3RouteMetric,
  ): void {
    const destKey = destination.toString();
    const viaKey = viaNeighbour.toString();

    let dest = this.destinations.get(destKey);
    if (!dest) {
      if (this.destinations.size >= this.options.maxDestinations) {
        return; // heuristic 9: destination list full — ignore new destinations
      }
      dest = { alias, routes: new Map() };
      this.destinations.set(destKey, dest);
      this.callsignByKey.set(destKey, destination);
    } else if (alias !== "") {
      dest.alias = alias;
    }

    this.callsignByKey.set(viaKey, viaNeighbour);
    const existing = dest.routes.get(viaKey);
    if (existing) {
      // Refresh the time-route in place: keep the route's quality (its other metric
      // space) and reset obsolescence so the time-route ages like a quality route
      // refreshed by a NODES broadcast.
      dest.routes.set(viaKey, {
        ...existing,
        obsolescence: this.options.obsoleteInitial,
        inp3: metric,
      });
    } else {
      // A brand-new route known only via INP3: quality 0 (no NODES quality), the
      // time metric carrying its reachability. Quality 0 means it is invisible to
      // the quality path / never advertised, exactly as intended.
      dest.routes.set(viaKey, {
        neighbour: viaNeighbour,
        quality: NETROM_QUALITY_MIN,
        obsolescence: this.options.obsoleteInitial,
        inp3: metric,
      });
    }

    this.enforceRouteCap(dest);
  }

  // Withdraw the INP3 metric of the (destination via viaNeighbour) route (a horizon
  // withdrawal). Clears inp3 only — a coexisting quality route stays. A route left
  // with neither a usable quality (≤ MINQUAL / 0) nor an INP3 metric is removed; a
  // destination left with no route is removed. A no-op if the route / destination is
  // unknown or the route had no INP3 metric. Mirrors the C# `WithdrawInp3`.
  private withdrawInp3(destination: Callsign, viaNeighbour: Callsign): void {
    const destKey = destination.toString();
    const viaKey = viaNeighbour.toString();

    const dest = this.destinations.get(destKey);
    if (!dest) {
      return;
    }
    const route = dest.routes.get(viaKey);
    if (!route || route.inp3 === undefined) {
      return; // nothing INP3 to withdraw on this route
    }

    // A route whose only reason to exist was its (now-withdrawn) time metric — i.e.
    // it carries no usable quality — is removed outright; otherwise it survives as a
    // pure quality route with inp3 cleared.
    const hasUsableQuality =
      route.quality > NETROM_QUALITY_MIN && route.quality >= this.options.minQuality;
    if (hasUsableQuality) {
      dest.routes.set(viaKey, { ...route, inp3: undefined });
    } else {
      dest.routes.delete(viaKey);
      if (dest.routes.size === 0) {
        this.destinations.delete(destKey);
      }
    }

    // Invariant (W): if the destination now holds NO Inp3-bearing route at all, it
    // has left the INP3 time-space → record it so the next RIF to every neighbour
    // carries a one-shot horizon withdrawal. (We had an Inp3 metric on this route a
    // moment ago, so this add is only ever reached on a genuine INP3 withdrawal.)
    if (!this.hasAnyInp3Route(destKey)) {
      this.recentlyWithdrawnSet.set(destKey, destination);
    }
  }

  // True iff some kept route to `destKey` still carries an inp3 metric. A
  // destination that is gone from the table holds no route, so it has no inp3 route
  // either. The "lost its LAST INP3 route" predicate for invariant (W) (design
  // §6.3). Mirrors the C# `HasAnyInp3Route`.
  private hasAnyInp3Route(destKey: string): boolean {
    const dest = this.destinations.get(destKey);
    if (!dest) {
      return false;
    }
    for (const route of dest.routes.values()) {
      if (route.inp3 !== undefined) {
        return true;
      }
    }
    return false;
  }

  // Drop neighbours that are no longer the next hop for any kept route. (A
  // neighbour we heard directly always has its own direct route, so it survives
  // until that route ages out — at which point it is a genuine orphan.)
  private pruneOrphanNeighbours(): void {
    if (this.neighbours.size === 0) {
      return;
    }
    const inUse = new Set<string>();
    for (const dest of this.destinations.values()) {
      for (const via of dest.routes.keys()) {
        inUse.add(via);
      }
    }
    for (const key of [...this.neighbours.keys()]) {
      if (!inUse.has(key)) {
        this.neighbours.delete(key);
      }
    }
  }
}

/** Ordinal (codepoint) string comparison — the TS analogue of C# `StringComparer.Ordinal`. */
function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Quantise a full-ms local target time down to the 10 ms wire granule the RIP codec
 * carries (the stored metric is full-ms — the granule is an emission-only concern,
 * design AMBIGUITY-I3-3). Floor, so the emitted finite time never exceeds the stored
 * one; clamped to one granule below the horizon so a near-horizon finite metric can
 * never round up to read as a withdrawal. Mirrors the C# `Quantise10`.
 */
function quantise10(targetTimeMs: number): number {
  const quantised = Math.trunc(targetTimeMs / 10) * 10;
  return Math.min(quantised, INP3_HORIZON_MS - 10);
}

/** Case-insensitive comparison — the TS analogue of C# `StringComparer.OrdinalIgnoreCase`. */
function compareCaseInsensitive(a: string, b: string): number {
  const la = a.toUpperCase();
  const lb = b.toUpperCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}
