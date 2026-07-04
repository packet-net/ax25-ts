/**
 * General carrier-sense (CSMA) seam for the AX.25 engine — the TS mirror of the
 * C# `Packet.Ax25.Transport.ICarrierSense` + `Packet.Ax25.Session.CarrierSenseGate`.
 *
 * This is a neutral, dependency-free medium-access capability: a source of
 * "is the channel busy right now?" that the {@link Ax25Listener} consults before
 * it keys up, so the stack can defer a transmission while another station is on
 * the air — emulating a TNC that exposes DCD. It is deliberately radio-agnostic:
 * a browser consumer that can observe channel occupancy (a hardware DCD line, a
 * squelch/RSSI reading, a KISS DCD extension) implements {@link CarrierSense}; a
 * consumer that cannot simply supplies no source, and the gate treats the absent
 * source as always-clear (fail-open) — traffic never stops because carrier-sense
 * is missing.
 */

/**
 * Optional medium-access capability: a source of carrier-sense (DCD) the AX.25
 * listener consults before it keys the radio. Mirrors the C# `ICarrierSense`
 * (a `bool? ChannelBusy` property — here a `channelBusy()` method, an idiom
 * difference, re-read each slot so a live DCD edge is picked up promptly).
 */
export interface CarrierSense {
  /**
   * Last known carrier-sense state: `true` while the channel is busy (RF on
   * channel / hardware DCD asserted), `false` when idle, and `null` when
   * unknown (no report yet, or the source cannot sense carrier). The gate
   * treats anything other than a definite `true` as clear, so an unknown state
   * fails open rather than wedging transmission.
   */
  channelBusy(): boolean | null;
}

/** Tuning for {@link CarrierSenseGate} — the slot-time CSMA knobs. Mirrors C# `CarrierSenseGateOptions`. */
export interface CarrierSenseGateOptions {
  /**
   * How often the gate re-samples carrier-sense while waiting for a busy channel
   * to clear (the CSMA slot interval). Default 100 ms — the KISS SLOTTIME default.
   */
  slotTimeMs?: number;
  /** Longest a transmission is held waiting for the channel to clear before fail-open. Default 10 000 ms. */
  maxWaitMs?: number;
  /**
   * When the bounded wait expires: `true` (default) transmits anyway —
   * carrier-sense must never wedge traffic; `false` throws instead.
   */
  failOpen?: boolean;
}

/**
 * The native carrier-sense CSMA gate at the AX.25 listener's transmit path.
 * Before the listener keys the radio it consults this gate, which holds the
 * transmission while {@link CarrierSense.channelBusy} reports the channel busy
 * and releases it once the channel clears (or a bounded wait expires —
 * fail-open). Mirrors the C# `Packet.Ax25.Session.CarrierSenseGate`.
 *
 * Wait-for-clear with slot-time polling — the simplest of the §6.4.2 CSMA family,
 * and enough for a half-duplex packet channel. An unknown busy-state (no source,
 * no edge seen yet, telemetry faulted) is treated as clear and fails open.
 *
 * Off by default: constructed with a `null` source, the gate always reports clear
 * immediately, so a stack with no carrier-sense wired behaves byte-for-byte as
 * before — the SDL transition behaviour is unchanged; only the *physical* keyup is
 * deferred, and only when a source is present and the channel is genuinely busy.
 */
export class CarrierSenseGate {
  private readonly source: CarrierSense | null;
  private readonly slotTimeMs: number;
  private readonly maxWaitMs: number;
  private readonly failOpen: boolean;

  /**
   * Build a gate over an optional carrier-sense source. A `null` (or omitted)
   * source is the degenerate always-clear gate (no CSMA — the stack keys up
   * immediately, exactly as with no gate at all).
   */
  constructor(source: CarrierSense | null = null, options: CarrierSenseGateOptions = {}) {
    this.source = source;
    this.slotTimeMs = options.slotTimeMs ?? 100;
    this.maxWaitMs = options.maxWaitMs ?? 10_000;
    this.failOpen = options.failOpen ?? true;
  }

  /**
   * True when a carrier-sense source is attached — i.e. this listener does native
   * CSMA. False for the always-clear degenerate gate. (Inspection convenience; does
   * not affect transmission.)
   */
  get hasSource(): boolean {
    return this.source !== null;
  }

  /**
   * True when the channel can be keyed *right now* without waiting: there is no
   * source, or the last-known state is anything other than a definite `true`
   * (clear / unknown both key up — unknown fails open).
   */
  private clearNow(): boolean {
    return this.source === null || this.source.channelBusy() !== true;
  }

  /**
   * Invoke `send` once the channel is clear. **Fast path:** when the channel is
   * clear/unknown (or there is no source), `send` runs *synchronously* — no
   * microtask hop, no reordering, byte-for-byte the un-gated path. Only a definite
   * "busy" defers `send` onto the slot-time poll loop. This is the sink the
   * fire-and-forget per-session/connectionless transmit paths use so the common
   * (no-CSMA) case is unchanged.
   */
  gatedSend(send: () => void): void {
    if (this.clearNow()) {
      send();
      return;
    }
    void this.waitLoop().then(send);
  }

  /**
   * Await a clear channel before the caller keys the radio. Resolves immediately
   * (already-resolved) when there is no source or the channel is clear/unknown;
   * otherwise polls the source every `slotTimeMs` until it clears or `maxWaitMs`
   * elapses.
   *
   * @returns How long the caller waited (0 when it was already clear).
   * @throws Error when the bounded wait expires and `failOpen` is `false`. With
   *   fail-open `true` (the default) the wait instead returns and the caller
   *   transmits anyway.
   */
  async waitForClear(): Promise<number> {
    if (this.clearNow()) return 0;
    return this.waitLoop();
  }

  private async waitLoop(): Promise<number> {
    const started = Date.now();
    for (;;) {
      // Re-read each slot: only a definite "busy" holds us; a clear or an unknown
      // state (source went dark) releases the keyup (fail-open).
      if (this.clearNow()) return Date.now() - started;

      const waited = Date.now() - started;
      if (waited >= this.maxWaitMs) {
        if (this.failOpen) return waited;
        throw new Error(
          `channel still busy after ${(this.maxWaitMs / 1000).toFixed(1)}s carrier-sense wait`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.slotTimeMs));
    }
  }
}
