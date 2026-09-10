import { AX25_GUARDS } from "ax25sdl";
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { createSessionBindings } from "../src/sdl/session-bindings.js";
import { createSessionContext } from "../src/sdl/session-context.js";
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

/**
 * The runtime half of the guard-binding gate, and the counterpart to
 * packet.net's `Binding_Table_Is_Exhaustive_Over_Ax25Guard`.
 *
 * `createSessionBindings` builds its table as a `Record<SessionBoundGuard, ...>`,
 * so a MISSING atom is already a compile error. This is not that check repeated:
 * the Map handed to callers is *derived* from that record via `Object.entries`
 * and then mutated by the trigger-scoped quirk wrappers, and none of that
 * derivation is covered by the record's type. An entry lost between the literal
 * and the returned Map would type-check perfectly and then throw
 * `GuardEvaluationError` on a live link, which is exactly the failure mode the
 * ax25spec#40 atom nearly shipped (`ax25sdl` 0.11.0).
 *
 * `AX25_GUARDS` (`ax25sdl` 0.12.0) is what makes this expressible at all: before
 * it, `Ax25Guard` was a type-only union with no runtime enumeration, so there was
 * nothing to iterate.
 */
describe("guard bindings are exhaustive over the generated closed set", () => {
  const local = Callsign.parse("M0LTEA");
  const remote = Callsign.parse("M0LTEB");

  /** Supplied by the MDL driver via extraBindings, not by the session. */
  const MDL_SUPPLIED = "RC_eq_NM201";

  function bindingsUnder(preset: typeof defaultSessionQuirks) {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...preset };
    return createSessionBindings(ctx, new RealTimerScheduler(), () => null);
  }

  it.each([
    ["default", defaultSessionQuirks],
    ["strictly faithful", strictlyFaithfulSessionQuirks],
  ])("every atom is bound and callable under the %s quirks", (_label, preset) => {
    const bindings = bindingsUnder(preset);
    const missing = AX25_GUARDS.filter(
      (atom) => atom !== MDL_SUPPLIED && !bindings.has(atom),
    );
    expect(missing).toEqual([]);

    // Bound is not the same as usable: an atom whose closure throws on a null
    // trigger is just as broken on air as one that was never bound at all.
    const threw = AX25_GUARDS.filter((atom) => {
      if (atom === MDL_SUPPLIED) return false;
      try {
        return typeof bindings.get(atom)!() !== "boolean";
      } catch {
        return true;
      }
    });
    expect(threw).toEqual([]);
  });

  it("leaves RC_eq_NM201 to the MDL driver", () => {
    // Carved out by type in session-bindings.ts. Asserted here so the carve-out
    // stays deliberate: if the session ever binds it, that is a decision to make
    // on purpose, not to discover when the two disagree.
    expect(bindingsUnder(defaultSessionQuirks).has(MDL_SUPPLIED)).toBe(false);
  });

  it("binds nothing that is not in the generated set", () => {
    const known = new Set<string>(AX25_GUARDS);
    const strays = [...bindingsUnder(defaultSessionQuirks).keys()].filter(
      (atom) => !known.has(atom),
    );
    expect(strays).toEqual([]);
  });
});
