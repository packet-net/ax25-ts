import type { Callsign } from "../callsign.js";
import {
  NETROM_QUALITY_MAX,
  NETROM_QUALITY_MIN,
  combineQuality,
} from "./quality.js";
import type { NodesBroadcastEntry } from "./nodes-broadcast-builder.js";
import type { NodesBroadcast } from "./nodes-broadcast.js";

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
  private readonly options: NetRomRoutingOptions;
  private readonly now: () => number;

  // destination callsign string -> its entry (alias + per-neighbour routes).
  private readonly destinations = new Map<string, DestinationState>();
  // neighbour callsign string -> directly-heard neighbour state.
  private readonly neighbours = new Map<string, NeighbourState>();
  // destination/neighbour callsign string -> the Callsign object (for snapshot reconstruction).
  private readonly callsignByKey = new Map<string, Callsign>();

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
      const survivors = new Map<string, RouteState>();
      for (const [via, route] of dest.routes) {
        const next = route.obsolescence - 1;
        if (next <= 0) {
          purged++;
          continue;
        }
        survivors.set(via, { ...route, obsolescence: next });
      }
      dest.routes = survivors;
      if (survivors.size === 0) {
        emptyDestinations.push(destKey);
      }
    }

    for (const dc of emptyDestinations) {
      this.destinations.delete(dc);
    }

    this.pruneOrphanNeighbours();
    return purged;
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

    this.callsignByKey.set(viaKey, viaNeighbour);
    dest.routes.set(viaKey, {
      neighbour: viaNeighbour,
      quality,
      obsolescence: this.options.obsoleteInitial,
    });

    // Heuristic 7: keep only the N best routes. If we now exceed the cap, evict
    // the lowest-quality route(s).
    if (dest.routes.size > this.options.maxRoutesPerDestination) {
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

/** Case-insensitive comparison — the TS analogue of C# `StringComparer.OrdinalIgnoreCase`. */
function compareCaseInsensitive(a: string, b: string): number {
  const la = a.toUpperCase();
  const lb = b.toUpperCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}
