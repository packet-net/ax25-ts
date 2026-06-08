import type { Callsign } from "../callsign.js";
import { Inp3L3RttFrame } from "./inp3-l3rtt.js";
import {
  type Inp3Options,
  type ResolvedInp3Options,
  resolveInp3Options,
} from "./inp3-options.js";
import { SNTT_SAMPLE_MAX_MS, SNTT_UNSET, smoothSntt } from "./inp3-sntt.js";
import type { NetRomPacket } from "./packet.js";

/**
 * Carries an INP3 link-down signal to an {@link Inp3Engine.onNeighbourDown}
 * handler: a previously-INP3-capable neighbour went silent past the reset window.
 * The handler wires it to `NetRomRoutingTable.markNeighbourDown(neighbour)` + a
 * DISC / re-establish of the interlink.
 *
 * Mirrors `Packet.NetRom.Transport.Inp3NeighbourDownEventArgs` on the C# side.
 */
export interface Inp3NeighbourDownEvent {
  /** The neighbour to `markNeighbourDown`. */
  readonly neighbour: Callsign;
  /** How long since its last reflection (≥ the reset window), in ms. */
  readonly silentForMs: number;
}

/**
 * An immutable snapshot of one neighbour's INP3 link-timing state, for surfacing /
 * tests (the {@link Inp3Engine.neighbours} projection).
 *
 * Mirrors `Packet.NetRom.Transport.Inp3NeighbourTiming` on the C# side.
 */
export interface Inp3NeighbourTiming {
  /** The neighbour callsign. */
  readonly neighbour: Callsign;
  /** The smoothed neighbour transport time (ms), or `null` if no measurement
   *  yet. */
  readonly snttMs: number | null;
  /** Whether the neighbour has advertised INP3 capability. */
  readonly inp3Capable: boolean;
  /** The IP version the neighbour accepts (from `$IX`), or `null`. */
  readonly ipAccept: number | null;
  /** Monotonic ms since the neighbour last reflected (or since it was registered,
   *  if it never has). */
  readonly lastReflectionAgeMs: number;
  /** Whether a probe is currently outstanding. */
  readonly awaitingReflection: boolean;
}

/**
 * The host-free INP3 *link-timing* engine: it owns the per-neighbour INP3 state,
 * probes each interlink neighbour with L3RTT datagrams on a cadence, times the
 * reflections (RTT ÷ 2 → the {@link smoothSntt} SNTT smoother), reflects a peer's
 * probes back verbatim, learns INP3 capability from the `$N` / `$IX` flags, and
 * fires {@link onNeighbourDown} when a previously-capable neighbour stops
 * reflecting for the reset window (default 180 s). This is INP3 slice I-2 — link
 * timing only; it produces the SNTT value the route layer (I-3) consumes but does
 * not itself touch the routing table beyond signalling a down neighbour.
 *
 * **Host-free.** Like {@link CircuitManager}, the engine has no AX.25 / node-host
 * / routing-table dependency — it speaks only {@link Callsign} +
 * {@link Inp3L3RttFrame} / {@link NetRomPacket} in and out. The host supplies a
 * {@link sendL3Rtt} sink (wrap the frame in a PID-0xCF I-frame on the neighbour's
 * interlink session) and subscribes {@link onNeighbourDown} (wired to
 * `NetRomRoutingTable.markNeighbourDown` + a DISC / re-establish).
 *
 * **Monotonic clock.** The engine is RTT-centric, so it measures every interval
 * as elapsed milliseconds since construction — `now() - startMs` — never a raw
 * wall-clock timestamp, so a clock step cannot corrupt an RTT or fire / suppress
 * the 180 s reset (the C# side gets this from a `TimeProvider`'s monotonic source;
 * here, like {@link NetRomCircuit}, the injected `now()` clock defaults to
 * `Date.now`, and the elapsed-since-construction subtraction is what keeps the
 * timing monotone). The C# `tickInterval` self-driving timer is dropped — the TS
 * embedder drives {@link tick} from a `setInterval`, keeping the library free of
 * ambient timers and trivially testable (the same choice {@link CircuitManager}
 * makes); the deterministic test path calls {@link tick} after advancing the
 * injected clock.
 *
 * **Totality.** The engine never throws on any inbound frame: a negative / stale
 * RTT, an unsolicited reflection, a reflection from an unknown neighbour, or a
 * non-L3RTT packet are all handled without corrupting the metric.
 *
 * Mirrors `Packet.NetRom.Transport.Inp3Engine` on the C# side.
 */
export class Inp3Engine {
  private _localNode: Callsign;
  private readonly resolved: ResolvedInp3Options;
  private readonly now: () => number;
  /** Captured at construction so every interval is measured as monotonic
   *  elapsed-ms (`now() - startMs`), never a raw clock value — the C# monotonic
   *  `TimeProvider.GetElapsedTime(startTimestamp)` semantics. */
  private readonly startMs: number;
  private readonly cadenceMs: number;
  private readonly resetWindowMs: number;

  private readonly neighbours_ = new Map<string, Inp3NeighbourState>();

  /**
   * The sink the host wires to ship an L3RTT datagram onto the interlink toward
   * `neighbour`. The host wraps `frame.toBytes()` in a PID-0xCF I-frame on that
   * neighbour's interlink session. Must be set before any probe is due. Mirrors
   * the C# `SendL3Rtt` property (and {@link CircuitManager.sendPacket}).
   */
  sendL3Rtt: ((neighbour: Callsign, frame: Inp3L3RttFrame) => void) | null = null;

  private readonly neighbourDownListeners: Array<
    (event: Inp3NeighbourDownEvent) => void
  > = [];

  /**
   * Construct the engine for a node. Mirrors the C# constructor (its optional
   * self-driving `tickInterval` is dropped — the TS embedder drives {@link tick}
   * from a `setInterval`, keeping the library free of ambient timers).
   *
   * @param localNode Our own L3 callsign — the origin we stamp into probes and the
   *   {@link Inp3L3RttFrame.isReflectionOf} self-test target. Settable later via
   *   {@link setLocalNode}.
   * @param options Cadence, reset window, SNTT gain, advertised capability.
   *   Defaults (and any omitted field) fill from {@link INP3_DEFAULTS};
   *   validated by {@link resolveInp3Options}.
   * @param now Injected clock returning epoch ms. Defaults to `Date.now` (the TS
   *   analogue of the C# `TimeProvider.System`).
   */
  constructor(
    localNode: Callsign,
    options?: Inp3Options,
    now: () => number = Date.now,
  ) {
    this._localNode = localNode;
    this.resolved = resolveInp3Options(options);
    this.now = now;
    this.startMs = now();
    this.cadenceMs = this.resolved.l3RttIntervalMs;
    this.resetWindowMs = this.resolved.l3RttResetWindowMs;
  }

  /**
   * Set the local node callsign stamped into the L3 origin of probes this engine
   * builds, and the target of the reflection self-test. The node host calls this
   * once the node identity is known (at first port attach). Affects probes built
   * *after* the call. Mirrors the C# `SetLocalNode`.
   */
  setLocalNode(node: Callsign): void {
    this._localNode = node;
  }

  /**
   * Subscribe to INP3 neighbour-down signals. The handler fires when a
   * previously-INP3-capable neighbour has not reflected within the reset window
   * (design §3); the host wires it to `NetRomRoutingTable.markNeighbourDown` +
   * DISC / re-establish. The engine has already reset (removed) that neighbour's
   * INP3 state by the time this fires, and it fires *after* the internal snapshot
   * loop so a re-entrant handler (e.g. {@link removeNeighbour}) cannot deadlock or
   * corrupt the iteration. Mirrors the C# `NeighbourDown` event.
   */
  onNeighbourDown(listener: (event: Inp3NeighbourDownEvent) => void): void {
    this.neighbourDownListeners.push(listener);
  }

  /**
   * Register / refresh awareness of an interlink neighbour (e.g. when an interlink
   * session is established, or a NODES neighbour is learned). Creates the
   * per-neighbour state with a fresh reset window if new; a no-op refresh if
   * already known. Probing then begins on the next due {@link tick} (once the
   * neighbour is known INP3-capable, or immediately if
   * {@link ResolvedInp3Options.probeUnknownCapability}).
   *
   * Mirrors the C# `ObserveNeighbour`.
   */
  observeNeighbour(neighbour: Callsign): void {
    this.ensureNeighbour(neighbour, this.nowMs());
  }

  /**
   * Drop a neighbour the host knows is gone (interlink torn down for non-INP3
   * reasons). Removes its INP3 state; {@link onNeighbourDown} is *not* fired (the
   * host already knows). Idempotent — dropping an unknown neighbour is a no-op, so
   * a re-entrant call from an {@link onNeighbourDown} handler is safe.
   *
   * Mirrors the C# `RemoveNeighbour`.
   */
  removeNeighbour(neighbour: Callsign): void {
    this.neighbours_.delete(keyOf(neighbour));
  }

  /**
   * Advance the engine by one tick: (a) for each neighbour due a probe
   * (capability-permitted, not awaiting a reflection, and cadence elapsed since
   * the last send) emit a {@link sendL3Rtt} and stamp the send; (b) for each
   * neighbour silent past the reset window, reset it — firing
   * {@link onNeighbourDown} only if it was INP3-capable (the AMBIGUITY-I2-3 guard:
   * a never-capable vanilla neighbour is dropped from probing silently, never
   * routing-torn-down). Sends and callbacks are invoked *after* the snapshot loop
   * (the snapshot-then-act pattern of {@link CircuitManager.tick} — a re-entrant
   * host handler cannot corrupt the iteration). Drive it from the embedder's
   * `setInterval` (production) or manually after advancing the injected clock
   * (tests). Mirrors the C# `Tick`.
   */
  tick(): void {
    const now = this.nowMs();

    // Collected during the snapshot loop, invoked after it — the
    // snapshot-then-act pattern of CircuitManager.tick so a re-entrant host
    // handler cannot corrupt the iteration.
    const toSend: Array<{ neighbour: Callsign; frame: Inp3L3RttFrame }> = [];
    const toRaise: Inp3NeighbourDownEvent[] = [];

    // Snapshot the entries so we can mutate the map (reset removes entries) while
    // iterating.
    for (const [key, n] of [...this.neighbours_.entries()]) {
      // Reset wins over probe for the same neighbour in the same tick: evaluate
      // it first and skip the probe branch if it fires.
      if (now - n.lastReflectionMs > this.resetWindowMs) {
        this.neighbours_.delete(key);
        if (n.inp3Capable) {
          toRaise.push({
            neighbour: n.neighbour,
            silentForMs: now - n.lastReflectionMs,
          });
        }
        // else: a never-capable neighbour that never reflected our optimistic
        // probes — drop it silently, NO neighbour-down (the guard: a vanilla peer
        // is reachable by NODES, it just doesn't speak L3RTT — we must not feed
        // its silence into routing).
        continue;
      }

      const mayProbe = n.inp3Capable || this.resolved.probeUnknownCapability;
      const cadenceElapsed =
        n.lastL3RttSentMs === NEVER_PROBED ||
        now - n.lastL3RttSentMs >= this.cadenceMs;
      if (mayProbe && !n.awaitingReflection && cadenceElapsed) {
        const frame = Inp3L3RttFrame.build(
          this._localNode,
          this.resolved.advertiseIpAccept ?? undefined,
          undefined,
          this.resolved.capabilityTextWidth,
        );
        n.lastL3RttSentMs = now;
        n.awaitingReflection = true;
        toSend.push({ neighbour: n.neighbour, frame });
      }
    }

    for (const { neighbour, frame } of toSend) {
      this.sendL3Rtt?.(neighbour, frame);
    }
    for (const event of toRaise) {
      for (const l of [...this.neighbourDownListeners]) {
        l(event);
      }
    }
  }

  /**
   * Feed an inbound L3RTT frame received from `neighbour` on the interlink (the
   * caller already recognised it as L3RTT). Two cases:
   *
   * - If it is a reflection of *our* probe ({@link Inp3L3RttFrame.isReflectionOf}
   *   with our local node, and we were awaiting one from this neighbour): compute
   *   RTT, feed RTT/2 to the SNTT smoother, stamp the reflection, clear the
   *   outstanding-probe flag, and learn the (echoed) capability.
   * - Otherwise it is a peer's probe to us: reflect it verbatim via
   *   {@link sendL3Rtt}, and learn the peer's `$N` / `$IX` capability from it.
   *
   * Never throws. Mirrors the C# `OnL3Rtt(Callsign, Inp3L3RttFrame)`.
   */
  onL3Rtt(neighbour: Callsign, frame: Inp3L3RttFrame): void;
  /**
   * Feed a raw {@link NetRomPacket} received from `neighbour`: if it is an L3RTT
   * frame the engine recognises and processes it (as the frame overload) and
   * returns `true`; otherwise it returns `false` with no state change (the packet
   * is something else the caller should route elsewhere). Never throws.
   *
   * Mirrors the C# `OnL3Rtt(Callsign, NetRomPacket)`.
   */
  onL3Rtt(neighbour: Callsign, packet: NetRomPacket): boolean;
  onL3Rtt(
    neighbour: Callsign,
    frameOrPacket: Inp3L3RttFrame | NetRomPacket,
  ): void | boolean {
    if (frameOrPacket instanceof Inp3L3RttFrame) {
      this.handleL3Rtt(neighbour, frameOrPacket);
      return;
    }

    // Raw-packet overload: classify first, return false (no state change) if it
    // is not an L3RTT frame.
    const frame = Inp3L3RttFrame.tryFrom(frameOrPacket);
    if (frame === null) {
      return false;
    }
    this.handleL3Rtt(neighbour, frame);
    return true;
  }

  /** The core L3RTT handler shared by both {@link onL3Rtt} overloads. */
  private handleL3Rtt(neighbour: Callsign, frame: Inp3L3RttFrame): void {
    const now = this.nowMs();

    const n = this.ensureNeighbour(neighbour, now);

    // Learn capability from whatever flags the frame carries (both directions
    // advertise capability; design §2.3).
    if (frame.inp3Capable) {
      n.inp3Capable = true;
    }
    if (frame.ipAccept !== null) {
      n.ipAccept = frame.ipAccept;
    }

    if (frame.isReflectionOf(this._localNode) && n.awaitingReflection) {
      // Our probe came back. The reflection itself proves liveness.
      const rtt = now - n.lastL3RttSentMs;
      n.awaitingReflection = false;
      n.lastReflectionMs = now;

      // A negative / stale RTT (clock went backwards) updates liveness but
      // contributes NO sample — never feed the filter a negative value (design
      // §2.4). A non-negative sample (= RTT/2) is clamped to the INP3 horizon and
      // seeded / smoothed inside smoothSntt (design §0.2–0.3).
      if (rtt >= 0) {
        // Clamp before narrowing to the SNTT horizon so a pathological RTT cannot
        // present as a small sample (under-reporting the link).
        const sample = Math.min(Math.floor(rtt / 2), SNTT_SAMPLE_MAX_MS);
        n.snttMs = smoothSntt(n.snttMs, sample, this.resolved.snttGainShift);
      }
    } else {
      // A peer's probe to us (origin != us, or we weren't awaiting a reflection —
      // an unsolicited / duplicate reflection is treated as a peer probe, never
      // as a metric sample). Reflect it verbatim (i1-wire-spec §1.4 locked
      // byte-for-byte echo).
      this.sendL3Rtt?.(neighbour, frame);
    }
  }

  /**
   * An immutable snapshot of per-neighbour timing state, for the console / MCP /
   * tests. Stable ordering by callsign (the `NetRomRoutingTable.snapshot`
   * discipline) so the surfaced output is deterministic. Mirrors the C#
   * `Neighbours` property.
   */
  get neighbours(): Inp3NeighbourTiming[] {
    const now = this.nowMs();
    return [...this.neighbours_.values()]
      .sort((a, b) => compareOrdinal(a.neighbour.toString(), b.neighbour.toString()))
      .map((n) => ({
        neighbour: n.neighbour,
        snttMs: n.snttMs !== SNTT_UNSET ? n.snttMs : null,
        inp3Capable: n.inp3Capable,
        ipAccept: n.ipAccept,
        lastReflectionAgeMs: now - n.lastReflectionMs,
        awaitingReflection: n.awaitingReflection,
      }));
  }

  /**
   * The smoothed neighbour transport time (ms) the route layer (I-3) reads for a
   * neighbour; `null` if the neighbour is unknown or has no measurement yet (still
   * {@link SNTT_UNSET}). A pure read. Mirrors the C# `SnttMs`.
   */
  snttMs(neighbour: Callsign): number | null {
    const n = this.neighbours_.get(keyOf(neighbour));
    if (n !== undefined && n.snttMs !== SNTT_UNSET) {
      return n.snttMs;
    }
    return null;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /** Monotonic milliseconds since construction (not wall-clock — design §2.1). */
  private nowMs(): number {
    return this.now() - this.startMs;
  }

  /**
   * Get-or-create a neighbour's state. A fresh entry seeds `lastReflectionMs = now`
   * (a full reset window before it can be torn down) and `snttMs = SNTT_UNSET` (no
   * measurement). Mirrors the C# `EnsureNeighbour`.
   */
  private ensureNeighbour(neighbour: Callsign, now: number): Inp3NeighbourState {
    const key = keyOf(neighbour);
    let n = this.neighbours_.get(key);
    if (n === undefined) {
      n = {
        neighbour,
        snttMs: SNTT_UNSET,
        lastL3RttSentMs: NEVER_PROBED,
        lastReflectionMs: now,
        inp3Capable: false,
        ipAccept: null,
        awaitingReflection: false,
      };
      this.neighbours_.set(key, n);
    }
    return n;
  }
}

/**
 * Sentinel for {@link Inp3NeighbourState.lastL3RttSentMs} meaning "no probe ever
 * sent" — distinct from the monotonic clock's legitimate `0` at engine start (a
 * probe genuinely sent at `t=0` must not read as never-sent, or the cadence gate
 * re-fires it every tick). The C# uses `long.MinValue`; `Number.NEGATIVE_INFINITY`
 * is the TS analogue — distinct from every finite elapsed-ms value, and the
 * explicit `=== NEVER_PROBED` guard means the cadence arithmetic never touches it.
 */
const NEVER_PROBED = Number.NEGATIVE_INFINITY;

/**
 * The per-neighbour INP3 link-timing state (design §1 / plan §5.1). A mutable
 * record, like `NetRomRoutingTable`'s neighbour state; all timestamps are
 * monotonic ms from the injected clock. Mirrors the C# private
 * `Inp3NeighbourState` class.
 */
interface Inp3NeighbourState {
  /** The neighbour callsign (kept so the snapshot/teardown can name it without
   *  re-parsing the map key). */
  readonly neighbour: Callsign;
  /** Smoothed neighbour transport time (the link metric); {@link SNTT_UNSET}
   *  until the first reflection. */
  snttMs: number;
  /** Monotonic ms when we last SENT a probe; {@link NEVER_PROBED} = never
   *  probed. */
  lastL3RttSentMs: number;
  /** Monotonic ms when this neighbour last reflected our probe (drives the reset
   *  timer); seeded to "now" at add-time. */
  lastReflectionMs: number;
  /** Learned from the peer's `$N` flag. */
  inp3Capable: boolean;
  /** From `$IX`, if advertised; else `null`. */
  ipAccept: number | null;
  /** A probe is outstanding (sent, not yet reflected). At most one in flight per
   *  neighbour — bounds state and makes "is this reflection ours?" unambiguous. */
  awaitingReflection: boolean;
}

/** The map key for a neighbour. C# keys the dictionary on the `Callsign` struct;
 *  TS keys on its canonical string (`Callsign.toString` is base[-ssid], a
 *  faithful identity key — the same choice {@link CircuitManager} makes). */
function keyOf(neighbour: Callsign): string {
  return neighbour.toString();
}

/** Ordinal (code-unit) string comparison — the TS analogue of C#
 *  `StringComparer.Ordinal`, for deterministic snapshot ordering. */
function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
