import { Callsign } from "../../src/callsign.js";
import {
  CircuitManager,
  type IncomingCircuitEvent,
  type NetRomCircuit,
  type NetRomCircuitCloseReason,
  type NetRomCircuitOptions,
  type NetRomPacket,
} from "../../src/netrom/index.js";

/**
 * A deterministic two-node NET/ROM L4 harness: two {@link CircuitManager}s ("A"
 * and "B") wired back-to-back over an in-process, controllable datagram channel
 * and a shared fake clock. The L4 analogue of the AX.25 conformance
 * {@link TwoStationHarness} (tests/conformance/two-station-harness.ts) — a run is
 * a pure function of the scenario + the channel policy, fully deterministic, no
 * wall-clock.
 *
 * Datagrams A emits are delivered to B and vice-versa (the channel stands in for
 * the AX.25 interlink that would carry PID-0xCF I-frames). The channel can
 * {@link dropNextAToB} / {@link dropNextBToA} a datagram or
 * {@link duplicateNextAToB} it to exercise loss / duplication recovery. Delivery
 * is synchronous and queued, drained by {@link pump}, so the whole exchange is
 * single-threaded and reproducible.
 *
 * Mirrors `Packet.NetRom.Tests.Transport.CircuitPairHarness` on the C# side. Its
 * `FakeTimeProvider` becomes a single mutable `nowMs` both managers' `now()`
 * clocks close over (the contention-free single-clock model — one clock shared,
 * not a scheduler per side, because the circuit's timer model is a poll on
 * {@link tick}, not arm/cancel).
 */
export class CircuitPairHarness {
  readonly aNode = new Callsign("GB7AAA", 0);
  readonly bNode = new Callsign("GB7BBB", 0);

  readonly a: CircuitManager;
  readonly b: CircuitManager;

  /** The shared virtual clock in epoch ms (the C# `FakeTimeProvider`). Advance it
   * via {@link advance}. */
  private nowMs: number;

  private readonly wire: Array<{ to: CircuitManager; packet: NetRomPacket }> = [];

  // Per-direction "drop / duplicate the next N datagrams" counters.
  private dropAToB = 0;
  private dropBToA = 0;
  private dupAToB = 0;
  private dupBToA = 0;

  constructor(options?: NetRomCircuitOptions, optionsB?: NetRomCircuitOptions) {
    // 2026-06-04 12:00:00Z, matching the C# harness's seed instant.
    this.nowMs = Date.UTC(2026, 5, 4, 12, 0, 0);
    const now = (): number => this.nowMs;
    const optsB = optionsB ?? options;
    this.a = new CircuitManager(this.aNode, options, now);
    this.b = new CircuitManager(this.bNode, optsB, now);

    // Each manager's outbound datagram is queued for delivery to the OTHER
    // manager, honouring the channel's drop/duplicate policy.
    this.a.sendPacket = (p) => this.enqueue(this.a, p);
    this.b.sendPacket = (p) => this.enqueue(this.b, p);
  }

  /** The current virtual time in epoch ms. */
  get time(): number {
    return this.nowMs;
  }

  private enqueue(from: CircuitManager, p: NetRomPacket): void {
    const aToB = from === this.a;
    const to = aToB ? this.b : this.a;

    if (aToB ? this.tryConsumeDropAToB() : this.tryConsumeDropBToA()) {
      return; // dropped on the channel
    }

    this.wire.push({ to, packet: p });

    if (aToB ? this.tryConsumeDupAToB() : this.tryConsumeDupBToA()) {
      this.wire.push({ to, packet: p }); // medium duplicated it
    }
  }

  private tryConsumeDropAToB(): boolean {
    if (this.dropAToB > 0) {
      this.dropAToB--;
      return true;
    }
    return false;
  }
  private tryConsumeDropBToA(): boolean {
    if (this.dropBToA > 0) {
      this.dropBToA--;
      return true;
    }
    return false;
  }
  private tryConsumeDupAToB(): boolean {
    if (this.dupAToB > 0) {
      this.dupAToB--;
      return true;
    }
    return false;
  }
  private tryConsumeDupBToA(): boolean {
    if (this.dupBToA > 0) {
      this.dupBToA--;
      return true;
    }
    return false;
  }

  /** Drop the next `count` datagrams A→B. */
  dropNextAToB(count = 1): void {
    this.dropAToB += count;
  }

  /** Drop the next `count` datagrams B→A. */
  dropNextBToA(count = 1): void {
    this.dropBToA += count;
  }

  /** Duplicate the next datagram A→B. */
  duplicateNextAToB(): void {
    this.dupAToB += 1;
  }

  /** Deliver every queued datagram (and any they cascade) until the wire is
   * empty. Mirrors the C# `Pump`. */
  pump(): void {
    let guard = 0;
    while (this.wire.length > 0) {
      if (guard++ >= 100_000) {
        throw new Error(
          "circuit exchange did not settle — possible send/ack livelock",
        );
      }
      const { to, packet } = this.wire.shift()!;
      to.onPacket(packet);
    }
  }

  /** Advance virtual time by `deltaMs`, fire both managers' retransmit ticks,
   * then drain the wire. Mirrors the C# `Advance`. */
  advance(deltaMs: number): void {
    this.nowMs += deltaMs;
    this.a.tick();
    this.b.tick();
    this.pump();
  }

  /** Open a circuit from A to B (mint + capture). The caller then drives
   * connect / send / disconnect and pumps. Mirrors the C# `OpenFromA`. */
  openFromA(): CapturedCircuit {
    return new CapturedCircuit(this.a.openCircuit(this.bNode));
  }

  /** Capture every inbound circuit B accepts, auto-accepting it. Returns a list
   * that fills as A connects in. Mirrors the C# `AutoAcceptOnB`. */
  autoAcceptOnB(): CapturedCircuit[] {
    const accepted: CapturedCircuit[] = [];
    this.b.onIncomingCircuit((e: IncomingCircuitEvent) => {
      accepted.push(new CapturedCircuit(e.circuit));
      CircuitManager.acceptIncoming(e);
    });
    return accepted;
  }
}

/**
 * A captured circuit end with its delivered data + lifecycle, for assertions.
 * Mirrors the C# `CircuitPairHarness.Captured`.
 */
export class CapturedCircuit {
  readonly received: Uint8Array[] = [];
  readonly closed: NetRomCircuitCloseReason[] = [];
  private _connected = false;

  constructor(readonly circuit: NetRomCircuit) {
    circuit.onData((d) => this.received.push(d));
    circuit.onConnected(() => {
      this._connected = true;
    });
    circuit.onClosed((r) => this.closed.push(r));
  }

  /** True once the circuit raised its Connected event. */
  get connected(): boolean {
    return this._connected;
  }

  /** All received logical frames concatenated. */
  get receivedBytes(): Uint8Array {
    let total = 0;
    for (const r of this.received) total += r.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const r of this.received) {
      out.set(r, offset);
      offset += r.length;
    }
    return out;
  }
}

/** ASCII-encode a string (the TS analogue of `Encoding.ASCII.GetBytes`). Lives in
 * the harness module (not a `.test.ts`) so the behavioural suites can share it
 * without importing one test file from another — which would re-collect that
 * file's `describe` block. */
export function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

/** Decode ASCII bytes back to a string (the TS analogue of `Encoding.ASCII.GetString`). */
export function asciiStr(b: Uint8Array): string {
  return String.fromCharCode(...b);
}
