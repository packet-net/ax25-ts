/**
 * The lifecycle state of a NET/ROM L4 circuit, and the reason it closed.
 *
 * A textbook connection FSM: Disconnected → (Connecting | listening) → Connected
 * → Disconnecting → Disconnected. Hand-written (NET/ROM has no SDL), kept small
 * and conventional.
 *
 * Mirrors `Packet.NetRom.Transport.NetRomCircuitState` +
 * `NetRomCircuitCloseReason` on the C# side. Uses the project's `as const`
 * value-union idiom (see `NetRomOpcode` in `transport-header.ts`) rather than a
 * TS `enum`, giving a compile-time-typed closed set without introducing the
 * project's first `enum`.
 */

/** The four lifecycle states of a circuit. */
export const NetRomCircuitState = {
  /** No circuit — the initial and terminal state. */
  Disconnected: "Disconnected",
  /** We sent a Connect Request and are awaiting the Connect Acknowledge. */
  Connecting: "Connecting",
  /** The circuit is up; Information may flow both ways. */
  Connected: "Connected",
  /** We sent a Disconnect Request and are awaiting the Disconnect Acknowledge. */
  Disconnecting: "Disconnecting",
} as const;

/** One circuit lifecycle state. */
export type NetRomCircuitState =
  (typeof NetRomCircuitState)[keyof typeof NetRomCircuitState];

/** Why a circuit ended — surfaced to the consumer on close. */
export const NetRomCircuitCloseReason = {
  /** A clean disconnect (either end requested it and it was acknowledged). */
  Normal: "Normal",
  /** The far end refused our Connect Request (Connect Acknowledge with the
   *  refuse bit). */
  Refused: "Refused",
  /** Retries were exhausted on a connect / disconnect / data message — the link
   *  is dead. */
  Timeout: "Timeout",
} as const;

/** One circuit close reason. */
export type NetRomCircuitCloseReason =
  (typeof NetRomCircuitCloseReason)[keyof typeof NetRomCircuitCloseReason];
