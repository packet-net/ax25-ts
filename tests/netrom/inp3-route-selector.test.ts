/**
 * The locked INP3 selection truth table (plan risk #4,
 * `docs/netrom-inp3-i3-design.md` §3) realised as unit + property tests over
 * {@link selectActiveRoute}. Covers every row — disabled⇒quality;
 * prefer+inp3⇒lowest-time; prefer+no-inp3⇒quality fallback; !prefer⇒quality —
 * plus the three "degenerate to today" invariants (§3.3).
 *
 * TS port of `tests/Packet.NetRom.Tests/Routing/Inp3RouteSelectorTests.cs`. Same
 * cases, same assertions, same boundary values. The C# `BeSameAs(dest.BestRoute)`
 * (reference identity) maps to vitest `toBe(...)`: the `destOf` helper sets
 * `bestRoute` to the *same object reference* as `routes[0]` (mirroring the C#
 * record's `BestRoute => Routes[0]`), so identity assertions carry over exactly.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import type {
  Inp3RouteMetric,
  NetRomDestination,
  NetRomRoute,
} from "../../src/netrom/routing-table.js";
import { selectActiveRoute } from "../../src/netrom/inp3-route-selector.js";

const NbrA = new Callsign("GB7AAA", 0);
const NbrB = new Callsign("GB7BBB", 0);
const NbrC = new Callsign("GB7CCC", 0);
const Dest = new Callsign("GB7SOT", 0);

// A quality-only route (today's vanilla triple; no INP3 metric).
function q(nbr: Callsign, quality: number): NetRomRoute {
  return { neighbour: nbr, quality, obsolescence: 6 };
}

// A route carrying both a quality and an INP3 (target-time) metric.
function t(
  nbr: Callsign,
  quality: number,
  targetTimeMs: number,
  hopCount: number,
): NetRomRoute {
  const inp3: Inp3RouteMetric = { targetTimeMs, hopCount };
  return { neighbour: nbr, quality, obsolescence: 6, inp3 };
}

// Build a destination from a best-quality-first route list (the ordering the
// table maintains; routes[0] is the quality-best route = today's bestRoute). The
// bestRoute field holds the *same object reference* as routes[0] so reference
// identity matches the C# `NetRomDestination.BestRoute => Routes[0]`.
function destOf(...routes: NetRomRoute[]): NetRomDestination {
  return {
    destination: Dest,
    alias: "SOT",
    routes,
    bestRoute: routes.length > 0 ? routes[0]! : null,
  };
}

describe("inp3 route selector", () => {
  // ---- Row: !prefer (and the disabled-overlay default) -> quality, byte-for-byte ----

  it("NotPrefer returns best quality route ignoring inp3", () => {
    // NbrA is quality-best (first); NbrB carries a far-better (lower) target time.
    // With prefer off, the INP3 metric is invisible — quality wins.
    const dest = destOf(
      t(NbrA, 200, 9000, 3),
      t(NbrB, 100, 10, 1),
    );

    const chosen = selectActiveRoute(dest, false);

    expect(chosen).toBe(dest.bestRoute);
    expect(chosen!.neighbour.equals(NbrA)).toBe(true);
  });

  it("NotPrefer returns best quality for quality-only destination", () => {
    const dest = destOf(q(NbrA, 200), q(NbrB, 100));

    const chosen = selectActiveRoute(dest, false);

    expect(chosen).toBe(dest.bestRoute);
    expect(chosen!.neighbour.equals(NbrA)).toBe(true);
  });

  // ---- Row: prefer + an INP3 route exists -> lowest-targetTimeMs INP3 route ----

  it("Prefer with inp3 routes selects lowest target time", () => {
    // Quality-best is NbrA; the lowest-target-time INP3 route is NbrC (5 ms).
    const dest = destOf(
      t(NbrA, 250, 8000, 2),
      t(NbrB, 120, 500, 4),
      t(NbrC, 60, 5, 7),
    );

    const chosen = selectActiveRoute(dest, true);

    expect(chosen!.neighbour.equals(NbrC)).toBe(true);
    expect(chosen!.inp3!.targetTimeMs).toBe(5);
  });

  it("Prefer picks inp3 route even when a higher-quality quality-only route exists", () => {
    // NbrA is the quality-best route but carries NO INP3 metric; NbrB is INP3.
    // Prefer must pick the INP3 route, not the higher-quality quality-only one.
    const dest = destOf(
      q(NbrA, 250),
      t(NbrB, 50, 1234, 3),
    );

    const chosen = selectActiveRoute(dest, true);

    expect(chosen!.neighbour.equals(NbrB)).toBe(true);
    expect(chosen!.inp3).not.toBeUndefined();
  });

  it("Prefer breaks target-time ties by lowest hop count", () => {
    const dest = destOf(
      t(NbrA, 200, 400, 5),
      t(NbrB, 200, 400, 2), // same time, fewer hops
      t(NbrC, 200, 400, 9),
    );

    const chosen = selectActiveRoute(dest, true);

    expect(chosen!.neighbour.equals(NbrB)).toBe(true);
  });

  it("Prefer breaks time and hop ties by neighbour callsign ordinal", () => {
    // All three tie on time AND hop; deterministic winner is the lowest ordinal
    // callsign, regardless of the order they appear in the routes list.
    const dest = destOf(
      t(NbrC, 200, 300, 4),
      t(NbrA, 200, 300, 4),
      t(NbrB, 200, 300, 4),
    );

    const chosen = selectActiveRoute(dest, true);

    expect(chosen!.neighbour.equals(NbrA)).toBe(true); // GB7AAA < GB7BBB < GB7CCC
  });

  // ---- Row: prefer but NO INP3 route -> quality fallback (byte-for-byte today) ----

  it("Prefer with no inp3 route falls back to best quality", () => {
    const dest = destOf(q(NbrA, 200), q(NbrB, 100));

    const chosen = selectActiveRoute(dest, true);

    expect(chosen).toBe(dest.bestRoute);
    expect(chosen!.neighbour.equals(NbrA)).toBe(true);
  });

  // ---- Degeneracy: single route -> same result regardless of mode ----

  it.each([false, true])(
    "Single quality route degenerates to that route in any mode (prefer=%s)",
    (prefer) => {
      const dest = destOf(q(NbrA, 180));

      const chosen = selectActiveRoute(dest, prefer);

      expect(chosen).toBe(dest.bestRoute);
      expect(chosen!.neighbour.equals(NbrA)).toBe(true);
    },
  );

  it.each([false, true])(
    "Single inp3 route is selected in any mode (prefer=%s)",
    (prefer) => {
      // One route that happens to carry an INP3 metric: prefer picks it as the
      // INP3 winner; !prefer picks it as the (only) quality route. Same neighbour
      // either way — single-route degeneracy holds across the metric spaces.
      const only = t(NbrA, 140, 250, 2);
      const dest = destOf(only);

      const chosen = selectActiveRoute(dest, prefer);

      expect(chosen).toBe(only);
    },
  );

  // ---- Degeneracy: empty destination -> null in any mode ----

  it.each([false, true])(
    "No routes returns null (prefer=%s)",
    (prefer) => {
      const dest = destOf(); // no routes at all

      expect(selectActiveRoute(dest, prefer)).toBeNull();
    },
  );

  // ---- Property: !prefer ALWAYS returns today's bestRoute (full degeneracy) ----

  const mixedRouteSets: NetRomRoute[][] = [
    [q(NbrA, 200), q(NbrB, 100)],
    [t(NbrA, 200, 9000, 3), t(NbrB, 100, 10, 1)], // INP3 present but ignored
    [q(NbrA, 255), t(NbrB, 50, 5, 1)],
    [t(NbrA, 1, 1, 1)], // single INP3-bearing route
  ];

  it.each(mixedRouteSets)(
    "NotPrefer always equals today's bestRoute (set #%#)",
    (...routes) => {
      const dest = destOf(...routes);

      const chosen = selectActiveRoute(dest, false);

      expect(chosen).toBe(dest.bestRoute);
    },
  );

  // ---- Property: prefer + quality-only set ALWAYS falls back to today's bestRoute ----

  const qualityOnlyRouteSets: NetRomRoute[][] = [
    [q(NbrA, 200)],
    [q(NbrA, 200), q(NbrB, 100)],
    [q(NbrA, 200), q(NbrB, 199), q(NbrC, 1)],
  ];

  it.each(qualityOnlyRouteSets)(
    "Prefer over quality-only set equals today's bestRoute (set #%#)",
    (...routes) => {
      const dest = destOf(...routes);

      const chosen = selectActiveRoute(dest, true);

      expect(chosen).toBe(dest.bestRoute);
    },
  );

  // ---- Property: prefer + ANY inp3 route -> a route with the minimum targetTimeMs ----

  const inp3BearingRouteSets: NetRomRoute[][] = [
    [t(NbrA, 200, 5, 2)],
    [t(NbrA, 200, 8000, 2), t(NbrB, 120, 500, 4), t(NbrC, 60, 5, 7)],
    [q(NbrA, 255), t(NbrB, 50, 1234, 3)], // quality-best is quality-only
    [t(NbrA, 200, 400, 5), t(NbrB, 200, 400, 2)], // tie on time
  ];

  it.each(inp3BearingRouteSets)(
    "Prefer selects a route with the minimum target time (set #%#)",
    (...routes) => {
      const dest = destOf(...routes);

      const chosen = selectActiveRoute(dest, true);

      const minTime = Math.min(
        ...routes.filter((r) => r.inp3 !== undefined).map((r) => r.inp3!.targetTimeMs),
      );
      // prefer with an INP3 route present must pick an INP3 route.
      expect(chosen!.inp3).not.toBeUndefined();
      expect(chosen!.inp3!.targetTimeMs).toBe(minTime);
    },
  );
});
