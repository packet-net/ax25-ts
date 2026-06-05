import { DEFAULT_TIME_TO_LIVE } from "./network-header.js";
import { MAX_PAYLOAD } from "./packet.js";

/**
 * The tunable knobs of the NET/ROM L4 transport (the circuit layer). As with the
 * routing options, NET/ROM has **no single normative standard** for these — the
 * canonical appendix names a few (OBSINIT-style defaults), but the timers and
 * window come from the de-facto reference (BPQ's `L4*` knobs / the Linux
 * `transport_*` tunables). Per CLAUDE.md every divergence is a named knob
 * defaulted to a widely interoperable value, never a silent BPQ-ism baked into
 * the state machine.
 *
 * All durations are in milliseconds and are read through the circuit's injected
 * `now()` clock (the TS analogue of the C# `TimeProvider`, §2.7) — no wall-clock
 * anywhere in the circuit layer.
 *
 * Mirrors `Packet.NetRom.Transport.NetRomCircuitOptions` on the C# side (its
 * `TimeSpan` timers become millisecond numbers, the established netrom idiom).
 * Modelled as a partial-override interface + a resolver to defaults, the
 * project's options idiom — not a record with C#-style static `Default` / `Bpq`
 * presets.
 */
export interface NetRomCircuitOptions {
  /**
   * The send-window size this node *proposes* in a Connect Request and the
   * maximum it will *accept* in a Connect Acknowledge. NET/ROM negotiates the
   * window down (the accepted size is ≤ both ends' proposals). Canonical / BPQ
   * default **4** (`L4WINDOW`); the 8-bit sequence space allows up to 127.
   */
  readonly windowSize?: number;

  /**
   * The transport retransmit timeout in ms (BPQ `L4TIMEOUT` / the Linux
   * `transport_timeout`): how long to wait for an ack before retransmitting the
   * oldest unacknowledged Information message. Default **5000** (5 s).
   */
  readonly retransmitTimeoutMs?: number;

  /**
   * Maximum retransmit attempts for a Connect / Disconnect / Information message
   * before the circuit is declared failed (BPQ `L4RETRIES` / the Linux
   * `transport_maximum_tries`). Default **3**.
   */
  readonly maxRetries?: number;

  /**
   * The initial time-to-live stamped into the L3 network header of datagrams this
   * circuit originates ({@link DEFAULT_TIME_TO_LIVE}).
   */
  readonly timeToLive?: number;

  /**
   * Maximum bytes of user data per Information datagram — the fragment size. A
   * logical send larger than this is split across several Information messages
   * with the more-follows flag set on all but the last. Canonical maximum (and
   * default) is {@link MAX_PAYLOAD} (236).
   */
  readonly fragmentSize?: number;

  /**
   * The number of queued-but-undelivered received Information messages at which
   * this node asserts *choke* (tells the peer to stop sending) — the receive-side
   * flow-control high-water mark. Choke is released once the backlog drains below
   * it. Default **0** meaning the receiver never self-chokes (it always drains
   * promptly — the node bridge does); a host that can stall its reader sets this
   * so backpressure reaches the wire.
   */
  readonly chokeThreshold?: number;
}

/** The fully-resolved options — every field present (no `undefined`). */
export interface ResolvedNetRomCircuitOptions {
  readonly windowSize: number;
  readonly retransmitTimeoutMs: number;
  readonly maxRetries: number;
  readonly timeToLive: number;
  readonly fragmentSize: number;
  readonly chokeThreshold: number;
}

/** The canonical / widely-interoperable defaults (the C# `NetRomCircuitOptions.Default`). */
export const NETROM_CIRCUIT_DEFAULTS: ResolvedNetRomCircuitOptions = {
  windowSize: 4,
  retransmitTimeoutMs: 5000,
  maxRetries: 3,
  timeToLive: DEFAULT_TIME_TO_LIVE,
  fragmentSize: MAX_PAYLOAD,
  chokeThreshold: 0,
};

/** Fill any omitted field of `options` from {@link NETROM_CIRCUIT_DEFAULTS}. */
export function resolveCircuitOptions(
  options?: NetRomCircuitOptions,
): ResolvedNetRomCircuitOptions {
  return {
    windowSize: options?.windowSize ?? NETROM_CIRCUIT_DEFAULTS.windowSize,
    retransmitTimeoutMs:
      options?.retransmitTimeoutMs ?? NETROM_CIRCUIT_DEFAULTS.retransmitTimeoutMs,
    maxRetries: options?.maxRetries ?? NETROM_CIRCUIT_DEFAULTS.maxRetries,
    timeToLive: options?.timeToLive ?? NETROM_CIRCUIT_DEFAULTS.timeToLive,
    fragmentSize: options?.fragmentSize ?? NETROM_CIRCUIT_DEFAULTS.fragmentSize,
    chokeThreshold:
      options?.chokeThreshold ?? NETROM_CIRCUIT_DEFAULTS.chokeThreshold,
  };
}
