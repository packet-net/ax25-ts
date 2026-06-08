import type { Callsign } from "../callsign.js";
import {
  type Inp3Options,
  type ResolvedInp3Options,
  resolveInp3Options,
} from "./inp3-options.js";

/**
 * The change class of a destination's selected INP3 route, set by whoever marks
 * it dirty (the table / ingestion path — design §3.2). NEGATIVE is immediate +
 * prioritised; POSITIVE is debounced + batched.
 *
 * Mirrors `Packet.NetRom.Transport.Inp3UpdateClass` on the C# side. Uses the
 * project's `as const` value-union idiom (see {@link NetRomCircuitState} in
 * `circuit-state.ts`) rather than a TS `enum`, giving a compile-time-typed closed
 * set without introducing the project's first `enum`.
 */
export const Inp3UpdateClass = {
  /** A new / improved / faster-next-hop route, or a sub-threshold worsening
   *  (routine SNTT jitter). Batched behind
   *  {@link ResolvedInp3Options.positiveDebounceMs}. */
  Positive: "Positive",
  /** A route lost (withdrawal / `MarkNeighbourDown` / aged out) or a selected
   *  target time worsened by >= the worsen threshold. Fans out immediately on the
   *  next {@link Inp3UpdateScheduler.tick}, ahead of any pending positive batch. */
  Negative: "Negative",
} as const;

/** One destination change class. */
export type Inp3UpdateClass =
  (typeof Inp3UpdateClass)[keyof typeof Inp3UpdateClass];

/**
 * Why a fan-out fired, carried on each {@link Inp3AdvertiseIntent} for
 * observability (design §3.6).
 *
 * Mirrors `Packet.NetRom.Transport.Inp3AdvertiseReason` on the C# side (same
 * `as const` value-union idiom as {@link Inp3UpdateClass}).
 */
export const Inp3AdvertiseReason = {
  /** A dirty-driven fan-out — a NEGATIVE change (immediate) or a debounced batch
   *  of POSITIVE changes. */
  Triggered: "Triggered",
  /** The baseline periodic full-RIF refresh on
   *  {@link ResolvedInp3Options.rifIntervalMs}, regardless of dirty state. */
  Periodic: "Periodic",
} as const;

/** One advertise reason. */
export type Inp3AdvertiseReason =
  (typeof Inp3AdvertiseReason)[keyof typeof Inp3AdvertiseReason];

/**
 * One "advertise to neighbour X now" intent the scheduler emits through
 * {@link Inp3UpdateScheduler.advertise}. The host turns it into
 * `table.buildRif(myCall, neighbour, preferInp3Routes)` (the full,
 * poison-reversed RIF) and a send over the neighbour's interlink session.
 *
 * Mirrors `Packet.NetRom.Transport.Inp3AdvertiseIntent` on the C# side (a
 * `readonly record struct` there; a value-record interface here, the established
 * netrom idiom for value records).
 */
export interface Inp3AdvertiseIntent {
  /** The INP3-capable neighbour to (re)advertise toward. */
  readonly neighbour: Callsign;
  /** Why this fan-out fired (triggered vs periodic). */
  readonly reason: Inp3AdvertiseReason;
}

/**
 * An immutable snapshot of the scheduler's pending dirty state, for surfacing /
 * tests (the {@link Inp3UpdateScheduler.status} projection).
 *
 * Mirrors `Packet.NetRom.Transport.Inp3SchedulerStatus` on the C# side.
 */
export interface Inp3SchedulerStatus {
  /** Destinations pending an immediate (NEGATIVE) fan-out. */
  readonly negativeDirty: number;
  /** Destinations pending a debounced (POSITIVE) fan-out. */
  readonly positiveDirty: number;
  /** The current INP3-capable fan-out target count. */
  readonly targetNeighbours: number;
}

/**
 * Sentinel for {@link Inp3UpdateScheduler}'s earliest-positive-mark anchor: "no
 * POSITIVE mark is pending", distinct from the monotonic clock's legitimate `0`
 * at construction (a positive marked at `t=0` must not read as "none pending").
 * The C# uses `long.MinValue`; `Number.NEGATIVE_INFINITY` is the faithful TS
 * analogue — strictly below any real monotonic-elapsed millisecond.
 */
const NEVER_MARKED = Number.NEGATIVE_INFINITY;

/**
 * The host-free INP3 *triggered-update timing* state machine (slice I-4,
 * design §3): it answers **"when do we emit a RIF, and toward whom?"** — never
 * *what* the RIF contains (that is `NetRomRoutingTable.buildRif`, the content
 * half). It consumes per-destination *dirty signals* (the table / ingestion path
 * tells it a destination changed, and how — {@link markDirty} /
 * {@link markWithdrawn}), consumes a host-driven {@link tick}, and emits
 * {@link Inp3AdvertiseIntent advertise intents} ("advertise to neighbour X now")
 * through the {@link advertise} sink. The host turns each intent into
 * `table.buildRif(myCall, X, preferInp3Routes)` + a send over X's interlink.
 *
 * **Host-free + intent-emitting.** Like the circuit layer, the scheduler owns no
 * I/O, no routing table, and no AX.25 session — it speaks only {@link Callsign}
 * in and {@link Inp3AdvertiseIntent} out. It is a pure function of (dirty
 * signals, clock) → intents. The split keeps each piece pure: `buildRif` is a
 * pure read of table state; the scheduler is pure timing; the host is the only
 * stateful glue (design §3.1).
 *
 * **Monotonic clock.** It times the debounce and the periodic interval off the
 * injected `now()` clock as a *monotonic*-elapsed value (ms since the start
 * captured in the constructor), never wall-clock — an NTP / DST step can never
 * fire or suppress a debounce (design §3.1). The C# reads
 * `TimeProvider.GetElapsedTime`; here, as in {@link CircuitManager}, the embedder
 * injects `now` (defaulting to `Date.now`) and elapsed is `now() - start`.
 * Deterministic under a fake clock: advance the injected `now`, call {@link tick},
 * assert the intents drained.
 *
 * **Per-destination dirty, per-neighbour fan-out.** Dirty state is tracked per
 * *destination* (a single change must reach every INP3-capable neighbour, each
 * with its own poison-reversed RIF at emit time — design §3.2); but the scheduler
 * only tracks *which destinations are dirty and at what priority* to decide
 * *whether / when / at what priority* to fan out — it never builds a partial RIF.
 * Every fan-out emits one intent per target neighbour, and the host rebuilds the
 * complete (full) poison-reversed RIF for each (design §3.3, "full RIF"): a
 * NEGATIVE fan-out therefore naturally carries the changed destination's
 * new/withdrawn state and subsumes any pending POSITIVE batch.
 *
 * **Totality.** Marking a destination dirty never throws; {@link tick} with no
 * neighbours, no dirty state, and no {@link advertise} sink is a no-op. The
 * recently-withdrawn set is *not* held here — it is table state (design
 * AMBIGUITY-I4-5: `buildRif` consumes-and-clears it); a withdrawal here only
 * escalates the destination to NEGATIVE so the fan-out is immediate.
 *
 * **No ambient timer.** The C# offers an optional self-driving `tickInterval`;
 * the node-host path passes `tickInterval: null` (host-driven). The TS port
 * mirrors *only* that host-driven path — there is no `setInterval` here; the
 * embedder calls {@link tick} (the same choice {@link CircuitManager} and
 * {@link NetRomService} make, keeping the library free of ambient timers and
 * trivially testable).
 *
 * Mirrors `Packet.NetRom.Transport.Inp3UpdateScheduler` on the C# side.
 */
export class Inp3UpdateScheduler {
  private readonly options: ResolvedInp3Options;
  private readonly now: () => number;
  private readonly start: number;
  private readonly rifIntervalMs: number;
  private readonly positiveDebounceMs: number;

  /** Per-destination dirty class, keyed by the destination's canonical callsign
   *  string (the netrom Map-keying idiom — see `circuit-manager.ts`). A
   *  destination is in at most one class at a time (design §3.2). Absent ⇒ clean.
   *  Values stored {@link Callsign} alongside the class so a fan-out / status
   *  read needs no re-parse. */
  private readonly dirty = new Map<
    string,
    { destination: Callsign; cls: Inp3UpdateClass }
  >();

  /** The INP3-capable neighbour set to fan out to — host-supplied
   *  ({@link setTargetNeighbours}); the scheduler never discovers neighbours
   *  (host-free, design §3.2/§3.6). Stored ordered-by-callsign so a fan-out emits
   *  intents in a deterministic order. */
  private targetNeighbours: Callsign[] = [];

  /** Monotonic ms of the *earliest still-pending* POSITIVE mark — the debounce
   *  anchor (design §3.3 rule 2: a steady positive drip drains within one
   *  {@link positiveDebounceMs} of the first, not perpetually deferred).
   *  {@link NEVER_MARKED} when no POSITIVE is pending. */
  private earliestPositiveMarkMs = NEVER_MARKED;

  /** Monotonic ms of the last periodic fan-out (design §3.3 rule 3), anchored at
   *  construction (monotonic `0`) so the first baseline refresh fires exactly one
   *  {@link rifIntervalMs} after the scheduler is built — timing depends only on
   *  the injected clock, not on when ticking begins. */
  private lastPeriodicMs = 0;

  private disposed = false;

  /**
   * The intent sink the host wires: for each fan-out the scheduler invokes this
   * once per target neighbour with "(re)build `buildRif(myCall, neighbour,
   * prefer)` and send it over `neighbour`'s interlink now". The intent carries
   * the {@link Inp3AdvertiseReason} for observability. Invoked *after* the
   * critical section (the snapshot-then-act discipline — a re-entrant host
   * handler that marks dirty / re-ticks cannot corrupt the in-flight tick).
   *
   * Mirrors the C# `Advertise` property.
   */
  advertise: ((intent: Inp3AdvertiseIntent) => void) | null = null;

  /**
   * Construct the scheduler. The C# offers an optional self-driving
   * `tickInterval`; the node-host path passes `null` (host-driven) and the TS
   * port mirrors *only* that — the embedder drives {@link tick}, so there is no
   * ambient timer here.
   *
   * @param options Timing knobs — the periodic RIF cadence
   *   ({@link Inp3Options.rifIntervalMs}) and the positive-update debounce
   *   ({@link Inp3Options.positiveDebounceMs}). Resolved to the canonical
   *   defaults for any omitted field.
   * @param now Injected clock returning epoch ms. Defaults to `Date.now` (the TS
   *   analogue of the C# `TimeProvider.System`); a fake clock in tests advances
   *   the injected `now`. Elapsed is computed relative to the value captured at
   *   construction, mirroring the C# monotonic-elapsed semantics.
   */
  constructor(options?: Inp3Options, now: () => number = Date.now) {
    this.options = resolveInp3Options(options);
    this.now = now;
    this.start = now();
    this.rifIntervalMs = this.options.rifIntervalMs;
    this.positiveDebounceMs = this.options.positiveDebounceMs;
  }

  /**
   * Set the INP3-capable neighbour set to fan out to. Host-supplied (e.g. from
   * the engine's neighbour set filtered to INP3-capable); the scheduler never
   * discovers neighbours. Replaces the previous set wholesale. Takes a defensive,
   * callsign-ordered copy so a later mutation of the caller's collection cannot
   * change which neighbours a fan-out targets and the order is deterministic.
   * Removing a neighbour here simply stops it receiving future fan-outs; it does
   * not clear any dirty state (the next fan-out reaches whatever set is current at
   * that {@link tick}).
   *
   * Mirrors the C# `SetTargetNeighbours`.
   */
  setTargetNeighbours(capableNeighbours: readonly Callsign[]): void {
    // Distinct + ordered: a duplicate in the host set must not double-advertise
    // to one neighbour, and a stable order keeps a fan-out's intents
    // deterministic (the same ordering discipline the snapshot / neighbour
    // surfaces use).
    const seen = new Set<string>();
    const snapshot: Callsign[] = [];
    for (const c of capableNeighbours) {
      const key = c.toString();
      if (!seen.has(key)) {
        seen.add(key);
        snapshot.push(c);
      }
    }
    snapshot.sort((a, b) => {
      const sa = a.toString();
      const sb = b.toString();
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    this.targetNeighbours = snapshot;
  }

  /**
   * Mark a destination dirty with a change class (design §3.2). The table /
   * ingestion path computes the class: NEGATIVE for a selected route worsened by
   * >= the worsen threshold; POSITIVE for a new / improved / faster-next-hop
   * route or a sub-threshold worsening. The class is **monotonic within the
   * debounce window**: a POSITIVE destination re-marked NEGATIVE is *upgraded* to
   * NEGATIVE (a loss must not be held back by a coincident positive); a NEGATIVE
   * destination re-marked POSITIVE is **not** downgraded. Never throws; the actual
   * fan-out happens on the next {@link tick} (NEGATIVE immediately, POSITIVE after
   * the debounce).
   *
   * Mirrors the C# `MarkDirty`.
   *
   * @param destination The destination whose selected INP3 route changed.
   * @param cls The change class (see {@link Inp3UpdateClass}).
   */
  markDirty(destination: Callsign, cls: Inp3UpdateClass): void {
    this.mark(destination, cls, this.nowMs());
  }

  /**
   * Mark a destination's selected INP3 route *withdrawn* (fully lost — no selected
   * INP3 route remains). A withdrawal is **always NEGATIVE** regardless of any
   * threshold (design §3.2: it is a removal, not a worsening) so it fans out on the
   * next {@link tick} immediately. The explicit one-shot horizon withdrawal RIP
   * itself is emitted by `buildRif` from the *table's* recently-withdrawn set
   * (design AMBIGUITY-I4-5) — the scheduler only escalates the timing here; it does
   * not hold the withdrawn set.
   *
   * Mirrors the C# `MarkWithdrawn`.
   */
  markWithdrawn(destination: Callsign): void {
    this.mark(destination, Inp3UpdateClass.Negative, this.nowMs());
  }

  /**
   * Advance the clock-driven state machine and fan out any updates now due. On
   * each tick (design §3.3), in precedence:
   *
   * 1. **Any NEGATIVE dirty → immediate, prioritised.** Emit a
   *    {@link Inp3AdvertiseReason.Triggered} intent for *every* target neighbour
   *    now and clear **all** dirty (the full poison-reversed RIF the host rebuilds
   *    subsumes pending positives too). No debounce.
   * 2. **Else POSITIVE dirty and debounce elapsed → batched.** If any destination
   *    is POSITIVE and `now - earliestPositiveMark >= positiveDebounce`, emit a
   *    {@link Inp3AdvertiseReason.Triggered} intent for every neighbour and clear
   *    the POSITIVE dirty. The debounce coalesces a burst of positives into one
   *    fan-out.
   * 3. **Independently, periodic interval elapsed → full RIF regardless.** If
   *    `now - lastPeriodicEmit >= rifInterval`, emit a
   *    {@link Inp3AdvertiseReason.Periodic} intent for every neighbour, stamp the
   *    periodic anchor, clear all dirty, and reset the debounce.
   *
   * Intents are collected in the critical section and invoked *after* it (the
   * snapshot-then-act discipline — a re-entrant host handler cannot corrupt the
   * in-flight tick). Drive it from the embedder's interval (production) or manually
   * after advancing a fake clock (tests).
   *
   * Mirrors the C# `Tick`.
   */
  tick(): void {
    const now = this.nowMs();
    let toRaise: Inp3AdvertiseIntent[] | null = null;

    // The periodic anchor was seeded to 0 (monotonic construction time), so the
    // first baseline refresh is due exactly one rifInterval after construction —
    // timing depends only on the injected clock, not on when ticking began.
    const periodicDue = now - this.lastPeriodicMs >= this.rifIntervalMs;

    let negativeDue = false;
    let positiveDue = false;
    if (!periodicDue) {
      for (const entry of this.dirty.values()) {
        if (entry.cls === Inp3UpdateClass.Negative) {
          negativeDue = true;
          break; // NEGATIVE dominates — no need to scan further.
        }
      }
      if (
        !negativeDue &&
        this.earliestPositiveMarkMs !== NEVER_MARKED &&
        now - this.earliestPositiveMarkMs >= this.positiveDebounceMs
      ) {
        positiveDue = true;
      }
    }

    // A periodic emit subsumes everything (full RIF) and takes the Periodic
    // reason; otherwise a NEGATIVE (immediate) or a debounced POSITIVE fans out as
    // Triggered. At most one fan-out per tick — the rebuilt full RIF carries all
    // current state, so there is never a reason to fan out twice.
    const reason: Inp3AdvertiseReason | null = periodicDue
      ? Inp3AdvertiseReason.Periodic
      : negativeDue || positiveDue
        ? Inp3AdvertiseReason.Triggered
        : null;

    if (reason !== null) {
      for (const neighbour of this.targetNeighbours) {
        (toRaise ??= []).push({ neighbour, reason });
      }

      // Clearing semantics (design §3.3):
      //  - Periodic and NEGATIVE both clear ALL dirty (the full RIF subsumes every
      //    pending change) and reset the debounce anchor.
      //  - A pure debounced-POSITIVE fan-out clears only POSITIVE dirty (there are
      //    no NEGATIVEs by construction — rule 1 would have won) which, in
      //    practice, is also all dirty; either way the debounce anchor resets.
      this.dirty.clear();
      this.earliestPositiveMarkMs = NEVER_MARKED;

      if (periodicDue) {
        this.lastPeriodicMs = now;
      }
    }

    if (toRaise !== null) {
      const sink = this.advertise;
      if (sink !== null) {
        for (const intent of toRaise) {
          sink(intent);
        }
      }
    }
  }

  /**
   * A point-in-time snapshot of pending dirty state, for surfacing / tests: how
   * many destinations are dirty NEGATIVE vs POSITIVE, and the current neighbour
   * fan-out count. A pure read.
   *
   * Mirrors the C# `Status` property.
   */
  get status(): Inp3SchedulerStatus {
    let negative = 0;
    let positive = 0;
    for (const entry of this.dirty.values()) {
      if (entry.cls === Inp3UpdateClass.Negative) {
        negative++;
      } else {
        positive++;
      }
    }
    return {
      negativeDirty: negative,
      positiveDirty: positive,
      targetNeighbours: this.targetNeighbours.length,
    };
  }

  /**
   * Release the scheduler's state. Idempotent. There is no ambient timer to stop
   * (host-driven tick), so this just drops the dirty + neighbour sets — the TS
   * analogue of the C# `Dispose`.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dirty.clear();
    this.targetNeighbours = [];
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /** Monotonic milliseconds since construction (not wall-clock — design §3.1, the
   *  injected-clock pattern), mirroring the C# `NowMs`. */
  private nowMs(): number {
    return this.now() - this.start;
  }

  /**
   * Apply a dirty mark with the monotonic-within-window rule: POSITIVE→NEGATIVE
   * upgrades; NEGATIVE→POSITIVE does not downgrade; a fresh POSITIVE anchors the
   * debounce window if none is pending. Mirrors the C# `MarkLocked` (there is no
   * lock in the single-threaded TS model).
   */
  private mark(destination: Callsign, cls: Inp3UpdateClass, now: number): void {
    const key = destination.toString();
    const existing = this.dirty.get(key);
    if (existing !== undefined) {
      // Upgrade-only: NEGATIVE dominates, so only POSITIVE→NEGATIVE changes the
      // stored class. NEGATIVE→POSITIVE (and same-class) leave it untouched.
      if (
        existing.cls === Inp3UpdateClass.Positive &&
        cls === Inp3UpdateClass.Negative
      ) {
        existing.cls = Inp3UpdateClass.Negative;
      }
      return;
    }

    this.dirty.set(key, { destination, cls });
    if (
      cls === Inp3UpdateClass.Positive &&
      this.earliestPositiveMarkMs === NEVER_MARKED
    ) {
      // Anchor the debounce on the EARLIEST still-pending positive so a steady
      // drip drains within one window of the first mark, not perpetually deferred.
      this.earliestPositiveMarkMs = now;
    }
  }
}
