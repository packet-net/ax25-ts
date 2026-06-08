import type { NetRomDestination, NetRomRoute } from "./routing-table.js";

/**
 * The pure INP3 route-**selection** policy: given a destination's kept routes and
 * the `preferInp3Routes` knob, decide which single {@link NetRomRoute} the node
 * treats as *active* for that destination (the route a `connect` or a best-route
 * forward resolves to). This is the locked truth table of plan risk #4 — the
 * coexistence of the two metric spaces (NODES quality vs INP3 measured target
 * time) — realised as a side-effect-free function (see
 * `docs/netrom-inp3-i3-design.md` §3).
 *
 * **The truth table.**
 *
 * - `preferInp3Routes === true` *and* the destination has at least one INP3 route
 *   (a route whose {@link NetRomRoute.inp3} is non-`undefined`): select the
 *   **lowest-{@link Inp3RouteMetric.targetTimeMs}** INP3 route, ties broken by
 *   lowest {@link Inp3RouteMetric.hopCount} then by neighbour callsign (ordinal)
 *   for determinism — the time-space mirror of the quality-space "highest
 *   quality, then callsign" ordering.
 * - Otherwise (the knob is off, *or* no INP3 route exists): fall back to the
 *   **best-quality** route — exactly today's behaviour,
 *   {@link NetRomDestination.bestRoute} (the first of the best-quality-first
 *   {@link NetRomDestination.routes} list). The {@link NetRomRoute.inp3} metric
 *   is never read on this path.
 *
 * **Degenerate-to-today invariant (the acceptance bar, §3.3).** Selection
 * collapses to today's quality path — byte-for-byte — in every case where INP3
 * cannot win: (1) the knob off ⇒ quality; (2) a destination with no INP3 route ⇒
 * quality fallback; (3) a single-route destination ⇒ that one route regardless of
 * mode. INP3 only ever changes the result for a destination that *both* opted in
 * via the knob and actually holds a time-route. The `enabled` overlay switch sits
 * above this function: when the overlay is disabled no INP3 route is ever
 * ingested, so {@link NetRomRoute.inp3} is `undefined` on every route and the
 * caller passes `preferInp3Routes: false` (or it is moot) — either way this
 * function returns the quality route unchanged.
 *
 * **Purity.** No table, engine, options-record, or I/O dependency; no allocation
 * on the hot path (the INP3 winner is found by a single linear scan with a
 * running-best, not a sort). The single `boolean` parameter is the
 * already-resolved `preferInp3Routes` knob (read by the host from
 * `NetRomInp3Options.preferInp3Routes`), so the selector itself stays free of the
 * options type.
 *
 * Mirrors `Packet.NetRom.Routing.Inp3RouteSelector` on the C# side. The C# method
 * lives on a static class; the TS analogue is a plain exported function — the
 * project's "behaviour is functions" idiom, the same shape as the wire codecs and
 * {@link decideForward}.
 *
 * @param dest The destination and its kept routes (best-quality first, the
 *   {@link NetRomDestination.routes} ordering the table maintains).
 * @param preferInp3Routes The resolved `preferInp3Routes` knob (BPQ's
 *   `PREFERINP3ROUTES`; `NetRomInp3Options.preferInp3Routes`). When `true` an
 *   INP3 route, if any, beats quality; when `false` the {@link NetRomRoute.inp3}
 *   metric is ignored entirely and quality wins.
 * @returns The lowest-target-time INP3 route when `preferInp3Routes` is set and
 *   one exists; otherwise the best-quality route
 *   ({@link NetRomDestination.bestRoute}); or `null` for a destination with no
 *   routes.
 */
export function selectActiveRoute(
  dest: NetRomDestination,
  preferInp3Routes: boolean,
): NetRomRoute | null {
  // Quality fallback path == today's behaviour, byte-for-byte: the first of the
  // best-quality-first routes list. Taken whenever the knob is off, or no INP3
  // route exists (handled below), or there are no routes at all.
  if (!preferInp3Routes) {
    return dest.bestRoute;
  }

  // preferInp3Routes === true: prefer the best INP3 route if the destination
  // holds any time-route; else fall back to quality. A single linear scan keeps a
  // running best by the time-space key (lowest targetTimeMs, then lowest
  // hopCount, then neighbour callsign ordinal) — no allocation, no sort.
  let bestInp3: NetRomRoute | null = null;
  for (const route of dest.routes) {
    if (route.inp3 === undefined) {
      continue; // a pure quality-route: invisible to the INP3 winner search.
    }
    if (bestInp3 === null || isBetterInp3(route, bestInp3)) {
      bestInp3 = route;
    }
  }

  // Any INP3 route ⇒ it wins; otherwise the quality fallback (degenerates to
  // today for a destination known only via NODES).
  return bestInp3 ?? dest.bestRoute;
}

/**
 * True if INP3 route `candidate` ranks strictly better than the current best
 * `incumbent` in the time metric space: lower {@link Inp3RouteMetric.targetTimeMs}
 * wins; ties broken by lower {@link Inp3RouteMetric.hopCount}, then by neighbour
 * callsign (ordinal) for a stable, deterministic choice. Both routes are assumed
 * INP3-bearing ({@link NetRomRoute.inp3} non-`undefined`) — the caller filters
 * quality-only routes out before comparing.
 *
 * Mirrors `Inp3RouteSelector.IsBetterInp3` on the C# side.
 */
function isBetterInp3(candidate: NetRomRoute, incumbent: NetRomRoute): boolean {
  const c = candidate.inp3!;
  const i = incumbent.inp3!;

  if (c.targetTimeMs !== i.targetTimeMs) {
    return c.targetTimeMs < i.targetTimeMs; // lowest target time = best.
  }
  if (c.hopCount !== i.hopCount) {
    return c.hopCount < i.hopCount; // tie-break: fewest hops.
  }

  // Final tie-break: neighbour callsign ordinal, for a deterministic winner
  // across the C#/TS/Rust ports (mirrors the quality-space callsign tie-break).
  return compareOrdinal(candidate.neighbour.toString(), incumbent.neighbour.toString()) < 0;
}

/** Ordinal (codepoint) string comparison — the TS analogue of C# `string.CompareOrdinal`. */
function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
