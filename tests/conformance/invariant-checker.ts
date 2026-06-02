/**
 * The conformance oracle — the TypeScript port of packet.net's
 * `InvariantChecker`. Encodes the invariants every correct AX.25 exchange must
 * satisfy, independent of the scenario that drove the harness there. Run after
 * every step (safety) and at the end of a converging run (liveness). A
 * violation throws {@link InvariantViolationError} with a precise message — in
 * happy-path tests that fails the test; under future generative testing it's a
 * shrinkable counterexample.
 *
 * Build and trust this on known-answer (happy-path) scenarios first — a fuzzer
 * is only as good as its oracle (see m0lte/packet.net
 * `docs/conformance-harness-plan.md`).
 */
import {
  type Endpoint,
  InvariantViolationError,
  type TwoStationHarness,
  outstanding,
} from "./two-station-harness.js";
import { modulus } from "../../src/sdl/session-context.js";

const KNOWN_STATES = new Set([
  "Disconnected",
  "AwaitingConnection",
  // The figc4.6 state's own SDL name (was mis-keyed "AwaitingConnection22" in
  // the driver's STATE_PAGES before the ax25Spec44 redirect made it routable —
  // the driver now keys it by the SDL spelling, so the oracle follows).
  "AwaitingV22Connection",
  "AwaitingRelease",
  "Connected",
  "TimerRecovery",
]);

// ─── Safety (must hold after every step) ────────────────────────────────

export function checkSafety(h: TwoStationHarness): void {
  checkDefinedState(h.a);
  checkDefinedState(h.b);
  checkSequenceSanity(h.a);
  checkSequenceSanity(h.b);
  // A delivers what B submitted; B delivers what A submitted.
  checkReliableDelivery(h.a, h.b);
  checkReliableDelivery(h.b, h.a);
}

function checkDefinedState(e: Endpoint): void {
  if (!KNOWN_STATES.has(e.state)) {
    throw new InvariantViolationError(
      `[${e.name}] is in undefined state '${e.state}'`,
    );
  }
}

/** Window invariant: V(s), V(a), V(r) are valid sequence numbers and the count
 * of outstanding (unacked) I-frames never exceeds the window k:
 * `0 <= (V(s) - V(a)) mod N <= k`. */
function checkSequenceSanity(e: Endpoint): void {
  const n = modulus(e.context);
  const { vs, va, vr, k } = e.context;

  if (vs < 0 || vs >= n) {
    throw new InvariantViolationError(`[${e.name}] V(s)=${vs} out of range [0,${n})`);
  }
  if (va < 0 || va >= n) {
    throw new InvariantViolationError(`[${e.name}] V(a)=${va} out of range [0,${n})`);
  }
  if (vr < 0 || vr >= n) {
    throw new InvariantViolationError(`[${e.name}] V(r)=${vr} out of range [0,${n})`);
  }

  const out = outstanding(e);
  if (out > k) {
    throw new InvariantViolationError(
      `[${e.name}] window exceeded: V(s)=${vs} V(a)=${va} => ${out} outstanding > k=${k} (state=${e.state})`,
    );
  }
}

/** Reliable, in-order, gap-free, duplicate-free delivery: the payloads
 * `receiver` surfaced upward must be an exact in-order prefix of what `sender`
 * submitted. */
function checkReliableDelivery(receiver: Endpoint, sender: Endpoint): void {
  const delivered = receiver.delivered;
  const submitted = sender.submitted;

  if (delivered.length > submitted.length) {
    throw new InvariantViolationError(
      `[${receiver.name}] delivered ${delivered.length} payloads but [${sender.name}] only submitted ` +
        `${submitted.length} — duplicate or spurious delivery`,
    );
  }

  for (let i = 0; i < delivered.length; i++) {
    if (!bytesEqual(delivered[i] as Uint8Array, submitted[i] as Uint8Array)) {
      throw new InvariantViolationError(
        `[${receiver.name}] delivery #${i} = [${hex(delivered[i] as Uint8Array)}] does not match ` +
          `[${sender.name}] submission #${i} = [${hex(submitted[i] as Uint8Array)}] — reorder/corruption/gap`,
      );
    }
  }
}

// ─── Liveness (must hold once a finite disruption has ceased) ───────────

/** Both windows empty (everything sent is acknowledged) and every submitted
 * payload delivered, in order, in both directions. */
export function assertConverged(h: TwoStationHarness): void {
  checkSafety(h);
  assertWindowEmpty(h.a);
  assertWindowEmpty(h.b);
  assertFullyDelivered(h.a, h.b);
  assertFullyDelivered(h.b, h.a);
}

function assertWindowEmpty(e: Endpoint): void {
  if (e.context.vs !== e.context.va) {
    throw new InvariantViolationError(
      `[${e.name}] not converged: V(s)=${e.context.vs} != V(a)=${e.context.va} ` +
        `(unacked frames remain, state=${e.state})`,
    );
  }
}

function assertFullyDelivered(receiver: Endpoint, sender: Endpoint): void {
  if (receiver.delivered.length !== sender.submitted.length) {
    throw new InvariantViolationError(
      `[${receiver.name}] delivered ${receiver.delivered.length} of [${sender.name}]'s ` +
        `${sender.submitted.length} submitted payloads — not fully delivered`,
    );
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
