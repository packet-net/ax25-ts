/**
 * Deterministic tests for {@link Inp3UpdateScheduler} (the INP3 triggered-update
 * timing state machine, slice I-4) driven by an injected fake clock:
 * negative-fires-immediately, positive-is-debounced-then-fires,
 * periodic-fires-on-interval, and negative-preempts-a-pending-positive-batch —
 * plus the monotonic-class (upgrade-not-downgrade) and debounce-coalescing
 * invariants (design §3.3 / §4 Storm).
 *
 * Ports the C# `Inp3UpdateSchedulerTests` faithfully (same cases, same
 * assertions, same boundary values). The C# `FakeTimeProvider` becomes an
 * injected `now()` the test advances; ms durations replace the C# `TimeSpan`s.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  Inp3AdvertiseReason,
  type Inp3AdvertiseIntent,
  Inp3UpdateClass,
  Inp3UpdateScheduler,
} from "../../src/netrom/inp3-update-scheduler.js";
import type { Inp3Options } from "../../src/netrom/inp3-options.js";

const N1 = new Callsign("GB7AAA", 0);
const N2 = new Callsign("GB7BBB", 0);
const N3 = new Callsign("GB7CCC", 0);

const DestA = new Callsign("M0AAA", 0);
const DestB = new Callsign("M0BBB", 0);

/** A controllable monotonic clock — the TS analogue of the C# `FakeTimeProvider`. */
class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.t += ms;
  }
}

const DEFAULT_OPTS: Inp3Options = {
  rifIntervalMs: 300_000, // 300 s
  positiveDebounceMs: 5_000, // 5 s
};

function newScheduler(
  clock: FakeClock,
  options: Inp3Options = DEFAULT_OPTS,
  neighbours: readonly Callsign[] = [N1, N2],
): { scheduler: Inp3UpdateScheduler; intents: Inp3AdvertiseIntent[] } {
  const intents: Inp3AdvertiseIntent[] = [];
  const scheduler = new Inp3UpdateScheduler(options, clock.now);
  scheduler.advertise = (i) => intents.push(i);
  scheduler.setTargetNeighbours(neighbours);
  return { scheduler, intents };
}

/** The set of neighbours an intent list fanned out to (callsign strings). */
function neighbourStrings(intents: Inp3AdvertiseIntent[]): string[] {
  return intents.map((i) => i.neighbour.toString());
}

describe("Inp3UpdateScheduler", () => {
  it("negative fires immediately on next tick for every neighbour", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock, DEFAULT_OPTS, [
      N1,
      N2,
      N3,
    ]);

    scheduler.markWithdrawn(DestA); // a loss is always NEGATIVE

    // No debounce on NEGATIVE: the very next tick (no clock advance) fans out.
    scheduler.tick();

    expect(intents).toHaveLength(3); // fans out to every INP3-capable neighbour at once
    expect(neighbourStrings(intents).sort()).toEqual(
      [N1, N2, N3].map((c) => c.toString()).sort(),
    );
    expect(
      intents.every((i) => i.reason === Inp3AdvertiseReason.Triggered),
    ).toBe(true);

    // The dirty flag cleared — a follow-up tick with no new change is silent.
    intents.length = 0;
    scheduler.tick();
    expect(intents).toHaveLength(0); // the NEGATIVE fan-out cleared the dirty flag
  });

  it("positive is debounced then fires", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock); // N1, N2

    scheduler.markDirty(DestA, Inp3UpdateClass.Positive);

    // Before the 5 s debounce elapses, ticking does NOT fan out the positive.
    scheduler.tick();
    expect(intents).toHaveLength(0); // held until the debounce elapses

    clock.advance(4_000);
    scheduler.tick();
    expect(intents).toHaveLength(0); // still inside the 5 s debounce window

    // Crossing the debounce boundary fans out once, to every neighbour.
    clock.advance(1_000); // t = 5 s == positiveDebounce
    scheduler.tick();
    expect(intents).toHaveLength(2); // drains to both neighbours once the window elapses
    expect(neighbourStrings(intents).sort()).toEqual(
      [N1, N2].map((c) => c.toString()).sort(),
    );
    expect(
      intents.every((i) => i.reason === Inp3AdvertiseReason.Triggered),
    ).toBe(true);

    // Drained — no repeat.
    intents.length = 0;
    clock.advance(10_000);
    scheduler.tick();
    expect(intents).toHaveLength(0); // the positive batch drained exactly once
  });

  it("positive burst within the window coalesces to one fan-out", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock); // N1, N2

    // Two positives marked at different times inside one debounce window.
    scheduler.markDirty(DestA, Inp3UpdateClass.Positive);
    clock.advance(2_000);
    scheduler.markDirty(DestB, Inp3UpdateClass.Positive);

    // The debounce is anchored on the EARLIEST mark (DestA at t=0), so it drains
    // at t=5 (one window after the first), not t=7.
    clock.advance(3_000); // t = 5 s
    scheduler.tick();

    expect(intents).toHaveLength(2); // a burst coalesces into ONE fan-out per neighbour
    expect(neighbourStrings(intents).sort()).toEqual(
      [N1, N2].map((c) => c.toString()).sort(),
    );
  });

  it("periodic fires on interval regardless of dirty state", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      rifIntervalMs: 300_000,
      positiveDebounceMs: 5_000,
    };
    const { scheduler, intents } = newScheduler(clock, opts); // N1, N2

    // No dirty state at all. Nothing fires before the interval.
    clock.advance(299_000);
    scheduler.tick();
    expect(intents).toHaveLength(0); // the periodic refresh has not yet reached its interval

    // Crossing the 300 s interval fires a Periodic fan-out to every neighbour.
    clock.advance(1_000); // t = 300 s
    scheduler.tick();
    expect(intents).toHaveLength(2); // the periodic full RIF fans out to every neighbour
    expect(neighbourStrings(intents).sort()).toEqual(
      [N1, N2].map((c) => c.toString()).sort(),
    );
    expect(intents.every((i) => i.reason === Inp3AdvertiseReason.Periodic)).toBe(
      true,
    );

    // And again one interval later — it re-anchors each time.
    intents.length = 0;
    clock.advance(300_000);
    scheduler.tick();
    expect(intents).toHaveLength(2); // the periodic refresh re-fires every interval
    expect(intents.every((i) => i.reason === Inp3AdvertiseReason.Periodic)).toBe(
      true,
    );
  });

  it("periodic subsumes a pending positive batch and resets the debounce", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      rifIntervalMs: 10_000,
      positiveDebounceMs: 5_000,
    };
    const { scheduler, intents } = newScheduler(clock, opts); // N1, N2

    // Mark a positive at t=6 s (after the first debounce boundary would have been,
    // had it been marked at t=0) — but here we mark it freshly so it would drain at
    // t=11 s. The periodic at t=10 s pre-empts it as a single Periodic fan-out.
    clock.advance(6_000);
    scheduler.markDirty(DestA, Inp3UpdateClass.Positive);

    clock.advance(4_000); // t = 10 s == rifInterval
    scheduler.tick();

    expect(intents).toHaveLength(2); // the periodic emit fans out once per neighbour
    // a periodic emit subsumes the pending positive batch (full RIF) — not a
    // second Triggered fan-out
    expect(intents.every((i) => i.reason === Inp3AdvertiseReason.Periodic)).toBe(
      true,
    );

    // The pending positive was cleared by the periodic; it does NOT re-drain later.
    intents.length = 0;
    clock.advance(5_000); // would have been the old debounce boundary
    scheduler.tick();
    expect(intents).toHaveLength(0); // the periodic cleared the pending positive and reset the debounce
  });

  it("negative preempts a pending positive batch", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock); // N1, N2

    // A positive is sitting in the debounce window...
    scheduler.markDirty(DestA, Inp3UpdateClass.Positive);
    clock.advance(2_000); // 2 s into the 5 s window

    // ...then a NEGATIVE arrives for a different destination. The next tick fans
    // out IMMEDIATELY (no waiting out the positive's debounce) as Triggered, and
    // clears BOTH the negative and the still-pending positive (full RIF subsumes).
    scheduler.markWithdrawn(DestB);
    scheduler.tick();

    expect(intents).toHaveLength(2); // the NEGATIVE pre-empts and fans out immediately to every neighbour
    expect(
      intents.every((i) => i.reason === Inp3AdvertiseReason.Triggered),
    ).toBe(true);

    // The previously-pending positive was subsumed — nothing left to drain at the
    // old debounce boundary.
    intents.length = 0;
    clock.advance(10_000); // well past the old positive's 5 s boundary
    scheduler.tick();
    expect(intents).toHaveLength(0); // the NEGATIVE fan-out subsumed the pending positive batch (full RIF)
  });

  it("negative upgrade within window is immediate and does not downgrade", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock); // N1, N2

    // POSITIVE then upgraded to NEGATIVE for the SAME destination → NEGATIVE wins.
    scheduler.markDirty(DestA, Inp3UpdateClass.Positive);
    scheduler.markDirty(DestA, Inp3UpdateClass.Negative); // upgrade

    expect(scheduler.status.negativeDirty).toBe(1); // POSITIVE→NEGATIVE upgrades the class
    expect(scheduler.status.positiveDirty).toBe(0);

    scheduler.tick();
    expect(intents).toHaveLength(2); // the upgraded-to-NEGATIVE destination fans out immediately
    expect(
      intents.every((i) => i.reason === Inp3AdvertiseReason.Triggered),
    ).toBe(true);

    // The reverse: NEGATIVE then POSITIVE for the same dest must NOT downgrade.
    intents.length = 0;
    scheduler.markDirty(DestB, Inp3UpdateClass.Negative);
    scheduler.markDirty(DestB, Inp3UpdateClass.Positive); // must NOT downgrade
    expect(scheduler.status.negativeDirty).toBe(1); // a loss cannot be demoted to a batched positive
    scheduler.tick();
    expect(intents).toHaveLength(2); // the still-NEGATIVE destination fans out immediately, not after a debounce
  });

  it("no neighbours means no intents even when dirty", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock, DEFAULT_OPTS, []);

    scheduler.markWithdrawn(DestA);
    scheduler.tick();
    expect(intents).toHaveLength(0); // with no target neighbours there is no one to advertise to

    // Adding neighbours later does not resurrect the already-cleared dirty flag —
    // the NEGATIVE was consumed by the (empty) fan-out on the previous tick.
    scheduler.setTargetNeighbours([N1]);
    scheduler.tick();
    expect(intents).toHaveLength(0); // the NEGATIVE dirty was cleared by the prior (empty) fan-out
  });

  it("duplicate neighbours are de-duplicated", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock, DEFAULT_OPTS, [
      N1,
      N1,
      N2,
    ]);

    scheduler.markWithdrawn(DestA);
    scheduler.tick();

    // a duplicate in the host neighbour set must not double-advertise to one neighbour
    expect(neighbourStrings(intents).sort()).toEqual(
      [N1, N2].map((c) => c.toString()).sort(),
    );
  });

  it("first tick does not fire a periodic immediately", () => {
    const clock = new FakeClock();
    const { scheduler, intents } = newScheduler(clock);

    // A brand-new scheduler ticked at t=0 must NOT fire a periodic — it waits one
    // full interval (the periodic anchor is set to "now" on the first tick).
    scheduler.tick();
    expect(intents).toHaveLength(0); // the periodic refresh waits one full interval after the first tick
  });
});
