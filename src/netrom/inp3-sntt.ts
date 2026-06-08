/**
 * The INP3 **SNTT** (Smoothed Neighbour Transport Time) integer IIR smoother —
 * the link-timing metric the route layer sums. It is an integer EWMA over
 * `RTT/2` raw samples, in milliseconds, with the same round-to-nearest integer
 * discipline as {@link combineQuality} (no floating point anywhere, so the
 * pico-node M0+ has no FPU dependency and the three stacks agree bit-for-bit).
 *
 * The locked default filter is a **1/8-gain IIR** (the AX.25 SRT smoothed
 * round-trip-time convention, a shift-by-3):
 * ```
 *   SNTT' = (7 × SNTT + sample + 4) / 8        (integer division)
 * ```
 * generalised to the configurable shift form so the gain stays a single integer
 * knob and the divide is a shift:
 * ```
 *   denom = 1 << gainShift                       // gainShift = 3 ⇒ denom 8 ⇒ gain 1/8
 *   SNTT' = ((denom - 1) × SNTT + sample + (denom >> 1)) >> gainShift
 * ```
 * The `+ (denom >> 1)` is round-to-nearest on the divide (exactly the `+ 128` in
 * `(a × b + 128) / 256`). This is a one-pole low-pass with gain `g = 1 / denom`:
 * `SNTT' = SNTT + (sample − SNTT) / denom`, rewritten to keep all intermediates
 * non-negative for the integer divide.
 *
 * **First-sample seeding (LOCKED).** A fresh neighbour has no history; seeding
 * SNTT = 0 would make the filter crawl up from zero and badly under-report the
 * link at first. The first valid sample therefore seeds the filter directly
 * (`SNTT := sample`, no smoothing on sample #1); every subsequent sample applies
 * the IIR. This is the canonical SRT/Karn seeding. The {@link SNTT_UNSET}
 * sentinel (`uint.MaxValue`) means "no measurement yet," distinct from a real
 * `0 ms` (a same-host loopback could legitimately measure ~0).
 *
 * **Overflow / range (LOCKED).** Samples are clamped to `[0, SNTT_SAMPLE_MAX_MS]`
 * (the INP3 600 s horizon — a transport time at/over the horizon is
 * "unreachable," and the 180 s link reset tears the link down long before a real
 * RTT reaches 600 s anyway). With both inputs ≤ 600 000, the worst-case
 * accumulator at the largest denom (256) is `255 × 600 000 + 600 000 + 128 =
 * 153 600 128` — far under `Number.MAX_SAFE_INTEGER`, so the integer math is
 * exact. The IIR is a convex combination of two values each in `[0, 600 000]`,
 * so the result stays in `[0, 600 000]`.
 *
 * **Gain is interop-tuning, NOT wire-compat.** Two nodes never exchange their
 * smoothing gain — only the resulting SNTT-derived target times in RIPs, and even
 * those are advisory. The gain only affects how twitchy vs. sluggish our own link
 * metric is. The default 1/8 is exposed as {@link SNTT_DEFAULT_GAIN_SHIFT} and is
 * configurable per-call; cross-stack parity is "identical given identical config,"
 * so all three stacks must use the same configured value.
 *
 * This is a pure value type — it carries only the smoothed value and the seeded
 * flag, holds no clock, and performs no I/O. The host-free `Inp3Engine` owns the
 * RTT measurement loop and feeds `RTT/2` samples here.
 *
 * Mirrors `Packet.NetRom.Routing.Inp3Sntt` on the C# side (design
 * `netrom-inp3-i2-design.md` §0; AMBIGUITY-I2-1).
 */

/**
 * The default SNTT IIR gain as a right-shift: `gain = 1 / (1 << shift)`. Default
 * `3` ⇒ gain `1/8` (the AX.25 SRT convention). Interop-tuning, not wire-compat
 * (design AMBIGUITY-I2-1). Mirrors `Inp3Sntt.DefaultGainShift`.
 */
export const SNTT_DEFAULT_GAIN_SHIFT = 3;

/**
 * The minimum valid gain shift (gain `1/2`). A shift of `0` would be gain `1` =
 * no smoothing (pointless), so it is rejected. Mirrors `Inp3Sntt.MinGainShift`.
 */
export const SNTT_MIN_GAIN_SHIFT = 1;

/**
 * The maximum valid gain shift (gain `1/256`). Past this the filter is sluggish
 * beyond usefulness. Mirrors `Inp3Sntt.MaxGainShift`.
 */
export const SNTT_MAX_GAIN_SHIFT = 8;

/**
 * The upper clamp on a raw sample, in milliseconds — the INP3 600 s "unreachable"
 * horizon (i1-wire-spec §2.4). A sample at/over this is clamped; the smoothed
 * result therefore also stays within `[0, SNTT_SAMPLE_MAX_MS]`. Mirrors
 * `Inp3Sntt.SampleMaxMs`.
 */
export const SNTT_SAMPLE_MAX_MS = 600_000;

/**
 * The "no measurement yet" sentinel for {@link Inp3Sntt.ms} — distinct from a
 * real `0 ms`. {@link Inp3Sntt.initialised} is the canonical test; this value is
 * exposed so callers that store the raw number (the per-neighbour state field)
 * can recognise the un-seeded state. Equals C# `uint.MaxValue` (`0xFFFFFFFF`).
 * Mirrors `Inp3Sntt.Unset`.
 */
export const SNTT_UNSET = 0xffffffff;

/**
 * Raw-number alias for {@link SNTT_UNSET}, for callers (e.g. the per-neighbour
 * state in `Inp3Engine`) that store the smoothed value as a bare number rather
 * than an {@link Inp3Sntt}. Identical to {@link SNTT_UNSET}. Mirrors
 * `Inp3Sntt.SnttUnset`.
 */
export const SNTT_UNSET_RAW = SNTT_UNSET;

/** Clamp a raw sample into `[0, SNTT_SAMPLE_MAX_MS]` (the horizon). */
function clampSample(sampleMs: number): number {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) {
    // C# takes a uint, so a negative is not representable; mirror the floor at 0.
    return 0;
  }
  const v = Math.trunc(sampleMs);
  return v > SNTT_SAMPLE_MAX_MS ? SNTT_SAMPLE_MAX_MS : v;
}

/** Validate a gain shift is in `[SNTT_MIN_GAIN_SHIFT, SNTT_MAX_GAIN_SHIFT]`,
 *  throwing the C# `ArgumentOutOfRangeException` analogue otherwise. */
function checkGainShift(gainShift: number): void {
  if (gainShift < SNTT_MIN_GAIN_SHIFT || gainShift > SNTT_MAX_GAIN_SHIFT) {
    throw new RangeError(
      `SNTT gain shift must be in [${SNTT_MIN_GAIN_SHIFT}, ${SNTT_MAX_GAIN_SHIFT}] (gain 1/2 .. 1/256). (gainShift)`,
    );
  }
}

/**
 * Fold a `RTT/2` sample into a raw-number smoothed value — the per-neighbour-state
 * form of {@link Inp3Sntt.update}. `currentMs` is {@link SNTT_UNSET_RAW} for an
 * un-seeded neighbour (the sample then seeds directly) or a prior smoothed value
 * (the IIR applies). Returns the new raw smoothed value (never
 * {@link SNTT_UNSET_RAW}).
 *
 * The pure-function bridge the engine uses; mirrors the static
 * `Inp3Sntt.Smooth(currentMs, sampleMs, gainShift)`.
 *
 * @param currentMs The prior smoothed value, or {@link SNTT_UNSET_RAW}.
 * @param sampleMs The new `RTT/2` sample, in milliseconds (clamped to {@link SNTT_SAMPLE_MAX_MS}).
 * @param gainShift The IIR gain shift, in `[SNTT_MIN_GAIN_SHIFT, SNTT_MAX_GAIN_SHIFT]`.
 */
export function smoothSntt(
  currentMs: number,
  sampleMs: number,
  gainShift: number,
): number {
  const state = currentMs === SNTT_UNSET ? Inp3Sntt.fresh() : Inp3Sntt.fromRaw(currentMs);
  return state.update(sampleMs, gainShift).ms;
}

/**
 * The INP3 SNTT integer IIR smoother — a pure value type carrying the smoothed
 * neighbour transport time (ms) and the seeded flag. Immutable: {@link update}
 * and {@link seed} return new instances, never mutating the source. Mirrors the
 * readonly C# struct `Inp3Sntt`.
 *
 * (C# is a `readonly struct`; TS has no value structs, so this is an immutable
 * class — the project's idiom for a stateful-but-immutable value record.)
 */
export class Inp3Sntt {
  private readonly _ms: number;

  private constructor(ms: number) {
    this._ms = ms;
  }

  /**
   * A fresh, un-seeded smoother — no measurement yet. The first {@link update}
   * seeds it directly from the sample. Mirrors `Inp3Sntt.Fresh`.
   */
  static fresh(): Inp3Sntt {
    return new Inp3Sntt(SNTT_UNSET);
  }

  /**
   * Seed a smoother directly from a first sample (no smoothing), e.g. when
   * reconstructing state. Equivalent to `Inp3Sntt.fresh().update(sampleMs)`. The
   * sample is clamped to `[0, SNTT_SAMPLE_MAX_MS]`. Mirrors `Inp3Sntt.Seed`.
   *
   * @param sampleMs The first `RTT/2` sample, in milliseconds.
   */
  static seed(sampleMs: number): Inp3Sntt {
    return new Inp3Sntt(clampSample(sampleMs));
  }

  /**
   * Reconstruct a smoother from a raw smoothed value (a per-neighbour state
   * field). Pass {@link SNTT_UNSET} for an un-seeded smoother. Internal-ish — the
   * {@link smoothSntt} bridge uses it; callers normally prefer {@link seed} /
   * {@link fresh}.
   */
  static fromRaw(ms: number): Inp3Sntt {
    return new Inp3Sntt(ms);
  }

  /**
   * True once at least one sample has been folded in. While false, {@link ms} is
   * {@link SNTT_UNSET} and the route layer must treat the neighbour as
   * contributing no time-route. Mirrors `Inp3Sntt.Initialised`.
   */
  get initialised(): boolean {
    return this._ms !== SNTT_UNSET;
  }

  /**
   * The smoothed neighbour transport time in milliseconds, or {@link SNTT_UNSET}
   * (`0xFFFFFFFF`) if no sample has been folded in yet. Always in
   * `[0, SNTT_SAMPLE_MAX_MS]` once {@link initialised}. Mirrors `Inp3Sntt.Ms`.
   */
  get ms(): number {
    return this._ms;
  }

  /**
   * The smoothed value as a nullable, for the route layer: the millisecond value
   * once {@link initialised}, else `null`. Mirrors `Inp3Sntt.Value`.
   */
  get value(): number | null {
    return this.initialised ? this._ms : null;
  }

  /**
   * Fold a new `RTT/2` sample into the smoother using the given gain shift
   * (`gain = 1 / (1 << gainShift)`), returning the new smoothed value. The first
   * sample seeds directly; every subsequent sample applies the integer IIR
   * `((denom-1)·SNTT + sample + denom/2) >> gainShift`. The sample is clamped to
   * `[0, SNTT_SAMPLE_MAX_MS]` before smoothing. Mirrors `Inp3Sntt.Update`.
   *
   * @param sampleMs The new `RTT/2` sample, in milliseconds.
   * @param gainShift The IIR gain as a right-shift, in `[SNTT_MIN_GAIN_SHIFT,
   *   SNTT_MAX_GAIN_SHIFT]`. Default 3 ⇒ 1/8.
   * @throws RangeError if `gainShift` is outside `[SNTT_MIN_GAIN_SHIFT, SNTT_MAX_GAIN_SHIFT]`.
   */
  update(sampleMs: number, gainShift: number = SNTT_DEFAULT_GAIN_SHIFT): Inp3Sntt {
    checkGainShift(gainShift);

    const sample = clampSample(sampleMs);

    // First valid sample seeds the filter directly (canonical SRT/Karn seeding);
    // smoothing begins at the second sample.
    if (!this.initialised) {
      return new Inp3Sntt(sample);
    }

    // Integer IIR, round-to-nearest:
    //   denom = 1 << gainShift
    //   SNTT' = ((denom - 1) * SNTT + sample + denom/2) >> gainShift
    //
    // Accumulator headroom: with SNTT ≤ 600_000 and sample ≤ 600_000 and the
    // largest denom (256), the worst case is 255*600_000 + 600_000 + 128 =
    // 153_600_128 — far under Number.MAX_SAFE_INTEGER. JS `number` is exact here;
    // Math.trunc on the non-negative accumulator/denom is the C# integer >>.
    const denom = 1 << gainShift;
    const accumulator = (denom - 1) * this._ms + sample + (denom >> 1);
    const smoothed = Math.trunc(accumulator / denom);

    // The IIR is a convex combination of two values each in [0, SNTT_SAMPLE_MAX_MS],
    // so the result is already in range — no clamp needed.
    return new Inp3Sntt(smoothed);
  }

  /** Value equality (by smoothed ms). Mirrors `Inp3Sntt.Equals`. */
  equals(other: Inp3Sntt): boolean {
    return this._ms === other._ms;
  }

  /** `"{ms} ms"` once initialised, else `"unset"`. Mirrors `Inp3Sntt.ToString`. */
  toString(): string {
    return this.initialised ? `${this._ms} ms` : "unset";
  }
}
