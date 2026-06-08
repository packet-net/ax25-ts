/**
 * The tunable knobs of the INP3 link-timing overlay — the probe cadence, the
 * reflection-timeout reset window, the SNTT smoother gain, optimistic-probe
 * policy, and the advertised capability text. Mirrors
 * {@link NetRomCircuitOptions} / `Packet.NetRom.Routing.NetRomRoutingOptions`: a
 * set of widely-interoperable defaults and validated ranges, every divergence a
 * named knob defaulted to an interoperable value (CLAUDE.md "spec-faithful core,
 * pragmatism is a named flag").
 *
 * All durations are in milliseconds (the established netrom idiom — the C#
 * `TimeSpan` timers become millisecond numbers) and are driven by the engine's
 * injected `now()` clock against a *monotonic* start — no wall-clock anywhere in
 * the INP3 layer.
 *
 * The SNTT gain ({@link Inp3Options.snttGainShift}) is interop-*tuning*, not
 * wire-compat: two nodes never exchange their smoothing constant, only the
 * resulting (advisory) SNTT-derived target times in RIPs. It does not have to
 * match a peer to interoperate — but cross-stack parity requires all three stacks
 * (C# / TS / Rust) use the same configured value (the "identical given identical
 * config" discipline, like the quality floor).
 *
 * Mirrors `Packet.NetRom.Wire.NetRomInp3Options` on the C# side (its `TimeSpan`
 * timers become millisecond numbers). Modelled as a partial-override interface +
 * a resolver to defaults, the project's options idiom — not a record with a
 * C#-style static `Default` preset.
 */
export interface Inp3Options {
  /**
   * How often to probe each (capable / optimistically-probed) interlink
   * neighbour with an L3RTT datagram. Plan §8 `l3RttIntervalSeconds` default
   * **60 s** (60000 ms).
   */
  readonly l3RttIntervalMs?: number;

  /**
   * Reflection-timeout → reset: how long a neighbour may go without reflecting a
   * probe before its INP3 state is torn down (and, for an INP3-capable
   * neighbour, `NeighbourDown` is raised). Plan §8 `l3RttResetSeconds` default
   * **180 s** (180000 ms; the spec value). Must exceed
   * {@link l3RttIntervalMs} — a reset window shorter than one probe interval
   * would tear down a live neighbour before it could answer.
   */
  readonly l3RttResetWindowMs?: number;

  /**
   * The SNTT IIR gain expressed as a right-shift: `gain = 1 / (1 << snttGainShift)`.
   * Default **3** ⇒ gain `1/8` (the AX.25 SRT convention; shift-by-3, no
   * multiply). Interop-tuning, **not** wire-compat (AMBIGUITY-I2-1). Valid range
   * **1..8** (gain 1/2 .. 1/256): 0 means gain 1 = no smoothing (pointless) and
   * > 8 is sluggish past usefulness.
   */
  readonly snttGainShift?: number;

  /**
   * Probe interlink neighbours whose INP3 capability is not yet known, to
   * bootstrap discovery (we only learn a peer speaks INP3 by receiving its probe
   * — AMBIGUITY-I2-2, so we must probe first). Default **true**. A never-capable
   * neighbour that never reflects is dropped from probing silently after one
   * reset window — it is *never* `MarkNeighbourDown`'d (AMBIGUITY-I2-3 guard);
   * only an INP3-capable neighbour that goes silent raises `NeighbourDown`.
   */
  readonly probeUnknownCapability?: boolean;

  /**
   * The IP version to advertise in our probes' `$IX` capability token (e.g. `4`),
   * or `null` for none (`$N` only). Plan §8 `advertiseIp`; off unless we run
   * IP-over-NET/ROM. Must be a single decimal digit 0–9 when set.
   */
  readonly advertiseIpAccept?: number | null;

  /**
   * The emit-side capability-text pad width for probes we build
   * (AMBIGUITY-L3RTT-3). Default {@link INP3_DEFAULT_CAPABILITY_TEXT_WIDTH} (the
   * C# `Inp3L3RttFrame.DefaultCapabilityTextWidth`). The recogniser is
   * width-independent, so this is purely cosmetic on the wire.
   */
  readonly capabilityTextWidth?: number;

  /**
   * Prefer INP3 (measured target-time) routes over NODES quality routes when
   * selecting the active route for a destination — BPQ's `PREFERINP3ROUTES` knob
   * (plan §8). Default **false**: even with the INP3 overlay enabled, the
   * conservative default keeps quality primary, so a node "turns INP3 on"
   * (ingesting + advertising time-routes) without changing where traffic flows;
   * flip this once the measured times are trusted. When `true`, a destination
   * that has *any* INP3 route forwards over its lowest-target-time INP3 route,
   * falling back to the best-quality route only when no INP3 route exists (the
   * selection truth table, plan risk #4 / `docs/netrom-inp3-i3-design.md` §3).
   * When `false` the {@link NetRomRoute.inp3} metric is ignored by selection
   * entirely (routes are still ingested + visible for monitoring and
   * re-advertisement). Consumed by `Inp3RouteSelector.selectActiveRoute`.
   */
  readonly preferInp3Routes?: boolean;

  /**
   * Master switch for the whole INP3 overlay (plan §8 `inp3.enabled`). Default
   * **false**: the node behaves exactly as it does today — no L3RTT probing, no
   * RIF ingestion or emission, no INP3 routes — so enabling the feature is a
   * deliberate opt-in. This is the host-layer gate that sits above the
   * (always-correct, host-free) engine + selector; when `false` the host simply
   * never drives them.
   */
  readonly enabled?: boolean;

  /**
   * The INP3 routing horizon in hops (plan §8 `hopLimit`): a RIP whose local hop
   * count would exceed this is not learned, bounding loop blast-radius. Default
   * **30**. The host passes this into the routing table's RIF ingestion.
   */
  readonly hopLimit?: number;

  /**
   * Periodic full-RIF cadence — the baseline refresh interval (plan §8
   * `rifIntervalSeconds`, design I-4 §6.2 "a periodic full RIF on the INP3
   * interval regardless"). Triggered updates fire regardless of this. Default
   * **300 s** (300000 ms). Consumed by the `Inp3UpdateScheduler`; separate from
   * NODESINTERVAL and from the L3RTT cadence. Must be positive.
   */
  readonly rifIntervalMs?: number;

  /**
   * Positive-update debounce — how long a NEW / BETTER (positive) route change is
   * batched before a fan-out, coalescing a burst of positive changes into one RIF
   * (design I-4 §3.3 rule 2). NEGATIVE changes (loss / worsen-past-threshold)
   * ignore this and fan out immediately. Default **5 s** (5000 ms). Must be
   * positive and strictly less than {@link rifIntervalMs} (a debounce >= the
   * periodic interval is pointless — the periodic emit would always drain the
   * batch first).
   */
  readonly positiveDebounceMs?: number;

  /**
   * The worsen-by amount (ms) at or above which a slowed selected route counts as
   * NEGATIVE (immediate fan-out) rather than POSITIVE (batched) — design
   * AMBIGUITY-I4-3. Sub-threshold worsenings are routine SNTT jitter and batched.
   * A loss / withdrawal is *always* NEGATIVE regardless of this threshold.
   * Default **1000 ms**. The table / ingestion path applies it when classifying a
   * change for `Inp3UpdateScheduler.markDirty`; it is a knob here so it is tunable
   * and cross-stack-pinned. Must be non-negative.
   */
  readonly worsenThresholdMs?: number;
}

/**
 * The emit-side capability-text pad width default — mirrors the C#
 * `Inp3L3RttFrame.DefaultCapabilityTextWidth` (8). Width-independent on the wire
 * (the recogniser ignores padding), so this is purely cosmetic.
 */
export const INP3_DEFAULT_CAPABILITY_TEXT_WIDTH = 8;

/** The fully-resolved options — every field present (no `undefined`). */
export interface ResolvedInp3Options {
  readonly l3RttIntervalMs: number;
  readonly l3RttResetWindowMs: number;
  readonly snttGainShift: number;
  readonly probeUnknownCapability: boolean;
  /** The advertised `$IX` IP-accept version, or `null` for `$N` only. */
  readonly advertiseIpAccept: number | null;
  readonly capabilityTextWidth: number;
  readonly preferInp3Routes: boolean;
  readonly enabled: boolean;
  readonly hopLimit: number;
  readonly rifIntervalMs: number;
  readonly positiveDebounceMs: number;
  readonly worsenThresholdMs: number;
}

/**
 * The canonical / widely-interoperable defaults (the C#
 * `NetRomInp3Options.Default`).
 */
export const INP3_DEFAULTS: ResolvedInp3Options = {
  l3RttIntervalMs: 60_000,
  l3RttResetWindowMs: 180_000,
  snttGainShift: 3,
  probeUnknownCapability: true,
  advertiseIpAccept: null,
  capabilityTextWidth: INP3_DEFAULT_CAPABILITY_TEXT_WIDTH,
  preferInp3Routes: false,
  enabled: false,
  hopLimit: 30,
  rifIntervalMs: 300_000,
  positiveDebounceMs: 5_000,
  worsenThresholdMs: 1_000,
};

/** Fill any omitted field of `options` from {@link INP3_DEFAULTS}. */
export function resolveInp3Options(options?: Inp3Options): ResolvedInp3Options {
  return {
    l3RttIntervalMs: options?.l3RttIntervalMs ?? INP3_DEFAULTS.l3RttIntervalMs,
    l3RttResetWindowMs:
      options?.l3RttResetWindowMs ?? INP3_DEFAULTS.l3RttResetWindowMs,
    snttGainShift: options?.snttGainShift ?? INP3_DEFAULTS.snttGainShift,
    probeUnknownCapability:
      options?.probeUnknownCapability ?? INP3_DEFAULTS.probeUnknownCapability,
    // `null` is an explicit, meaningful value ($N-only); only `undefined` falls
    // back to the default. `?? null` cannot reach the right-hand side because the
    // default is itself `null` — but the `?? null` keeps the nullish-coalesce
    // pattern uniform with the other fields.
    advertiseIpAccept:
      options?.advertiseIpAccept ?? INP3_DEFAULTS.advertiseIpAccept,
    capabilityTextWidth:
      options?.capabilityTextWidth ?? INP3_DEFAULTS.capabilityTextWidth,
    preferInp3Routes:
      options?.preferInp3Routes ?? INP3_DEFAULTS.preferInp3Routes,
    enabled: options?.enabled ?? INP3_DEFAULTS.enabled,
    hopLimit: options?.hopLimit ?? INP3_DEFAULTS.hopLimit,
    rifIntervalMs: options?.rifIntervalMs ?? INP3_DEFAULTS.rifIntervalMs,
    positiveDebounceMs:
      options?.positiveDebounceMs ?? INP3_DEFAULTS.positiveDebounceMs,
    worsenThresholdMs:
      options?.worsenThresholdMs ?? INP3_DEFAULTS.worsenThresholdMs,
  };
}

/**
 * Validate the option ranges, throwing {@link RangeError} on any out-of-range
 * field. Mirrors the C# `NetRomInp3Options.Validate` (its
 * `ArgumentOutOfRangeException` becomes a `RangeError`); the host's config
 * validator surfaces out-of-range YAML (plan §8). Accepts either a partial
 * (resolving defaults first) or an already-resolved options record.
 *
 * @throws {RangeError} Any field is out of its valid range.
 */
export function validateInp3Options(options?: Inp3Options): void {
  const o = resolveInp3Options(options);

  if (o.l3RttIntervalMs <= 0) {
    throw new RangeError("L3RTT probe interval must be positive");
  }
  if (o.l3RttResetWindowMs <= o.l3RttIntervalMs) {
    throw new RangeError(
      "L3RTT reset window must exceed the probe interval (a shorter window tears down a live neighbour before it can answer)",
    );
  }
  if (o.snttGainShift < 1 || o.snttGainShift > 8) {
    throw new RangeError(
      "SNTT gain shift must be in [1, 8] (gain 1/2 .. 1/256)",
    );
  }
  if (
    o.advertiseIpAccept !== null &&
    (o.advertiseIpAccept < 0 || o.advertiseIpAccept > 9)
  ) {
    throw new RangeError(
      "advertised IP-accept version must be a single decimal digit 0–9",
    );
  }
  if (o.capabilityTextWidth < 0) {
    throw new RangeError("capability text width must be non-negative");
  }
  if (o.hopLimit < 1) {
    throw new RangeError("INP3 hop limit must be at least 1");
  }
  if (o.rifIntervalMs <= 0) {
    throw new RangeError("periodic RIF interval must be positive");
  }
  if (o.positiveDebounceMs <= 0) {
    throw new RangeError("positive-update debounce must be positive");
  }
  if (o.positiveDebounceMs >= o.rifIntervalMs) {
    throw new RangeError(
      "positive-update debounce must be less than the periodic RIF interval (a debounce >= the interval is pointless — the periodic emit would always drain the batch first)",
    );
  }
  if (o.worsenThresholdMs < 0) {
    throw new RangeError("worsen threshold must be non-negative");
  }
}
