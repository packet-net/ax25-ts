import type { Callsign } from "../callsign.js";
import type { NetRomCircuit } from "./circuit.js";
import { NetRomCircuitState } from "./circuit-state.js";

/**
 * A duplex byte stream over a NET/ROM L4 {@link NetRomCircuit} — the network-routed
 * analogue of an {@link Ax25ListenerSession}. It wraps a circuit so an embedder (a
 * node console, packet-term-web, …) talks to a station reached *across the network*
 * exactly as it would over a local AX.25 session: the circuit's reassembled inbound
 * frames become readable chunks via {@link onData}, {@link write} hands data to the
 * circuit's send path, and a circuit close (either end's Disconnect, a refusal, a
 * timeout) settles {@link onClosed} / {@link closed}.
 *
 * Used both ways, exactly like the C# class: as the far side of an *outbound*
 * `connect <alias>` (the stream the caller relays the dialling user against — see
 * {@link NetRomConnector.connect}), and to wrap an *inbound* circuit a remote opened
 * to us (a routed user reaching our prompt — see
 * {@link NetRomConnector.onIncomingConnection}).
 *
 * **Idioms.** This is the event-driven TS shape (`onData` / `onClosed` callbacks +
 * an awaitable {@link completion}), mirroring how {@link Ax25ListenerSession} surfaces
 * data/disconnect, rather than the C#'s `Channel<T>` + `ReadAsync` pull model — the
 * data callback is wired before the circuit is accepted/connected so no inbound Info
 * that races the connect-ack is missed (the C# constructor subscribes
 * `circuit.DataReceived` for the same reason). The circuit is driven by the owning
 * {@link CircuitManager}'s `tick()`; this wrapper adds no timers.
 *
 * Mirrors `Packet.Node.Core.NetRom.NetRomNodeConnection` on the C# side.
 */
export class NetRomConnection {
  private readonly _circuit: NetRomCircuit;
  private readonly _peerId: string;
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly closedListeners: Array<() => void> = [];
  // Inbound chunks delivered before any data listener was attached are buffered
  // here and flushed to the first listener — so an inbound frame that races the
  // connect-ack (B accepts + sends its banner before A subscribes) is never lost.
  // This is the TS analogue of the C# class's unbounded inbound Channel, which
  // buffers regardless of when the reader pulls.
  private readonly inboundBuffer: Uint8Array[] = [];
  private disposed = false;
  private completed = false;
  private resolveCompletion!: () => void;
  private readonly _completion: Promise<void>;

  /**
   * Wrap `circuit` as a duplex stream to `peer` (the far node). Subscribes the
   * circuit's data + close events immediately — call this *before* the circuit is
   * connected/accepted so an inbound frame racing the handshake is delivered to a
   * reader that already exists (the C# constructor does the same). Mirrors the C#
   * constructor.
   */
  constructor(circuit: NetRomCircuit, peer: Callsign) {
    this._circuit = circuit;
    this._peerId = peer.toString();
    this._completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
    circuit.onData((data) => this.fireData(data));
    circuit.onClosed(() => this.complete());
  }

  /** The far node's callsign string — for logging / the `Info` command. Mirrors
   * the C# `PeerId`. */
  get peerId(): string {
    return this._peerId;
  }

  /** The underlying L4 circuit (for diagnostics / tests). */
  get circuit(): NetRomCircuit {
    return this._circuit;
  }

  /** True once the circuit has closed (the peer disconnected, or we tore it down). */
  get closed(): boolean {
    return this.disposed || this._circuit.state === NetRomCircuitState.Disconnected;
  }

  /**
   * A promise that resolves when the peer disconnects (or the connection is
   * otherwise torn down). The embedder's relay loop can race its read against this
   * so a peer-initiated drop unblocks it promptly. Mirrors the C# `Completion`
   * task.
   */
  get completion(): Promise<void> {
    return this._completion;
  }

  /**
   * Register a callback invoked with each reassembled inbound logical frame the
   * circuit delivers upward (one call per completed NET/ROM frame). The shape
   * mirrors {@link Ax25ListenerSession.onData}.
   *
   * After delivering a chunk the connection tells the circuit a frame has been
   * consumed ({@link NetRomCircuit.onDeliveryDrained}) so it can release choke if it
   * had asserted backpressure — the bridge delivers synchronously, mirroring the
   * C# `ReadAsync` calling `OnDeliveryDrained` after each read.
   */
  onData(callback: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(callback);
    // Flush any chunks that arrived before a listener existed (the C# channel's
    // buffer-then-read guarantee). Drain to the just-registered callback in order.
    if (this.inboundBuffer.length > 0) {
      const pending = this.inboundBuffer.splice(0, this.inboundBuffer.length);
      for (const chunk of pending) {
        callback(chunk);
      }
    }
  }

  /** Register a callback invoked when the circuit closes (peer disconnect / refusal
   * / timeout). The shape mirrors {@link Ax25ListenerSession.onDisconnected}. */
  onClosed(callback: () => void): void {
    this.closedListeners.push(callback);
  }

  /**
   * Send `bytes` to the peer over the circuit (fragmented + windowed by the
   * circuit's send path). A no-op after the connection is disposed/closed. Mirrors
   * the C# `WriteAsync` (which gates on the disposed flag).
   */
  write(bytes: Uint8Array): void {
    if (!this.disposed) {
      this._circuit.send(bytes);
    }
  }

  /**
   * Tear the connection down: disconnect the circuit if it is still up and settle
   * {@link completion}. Idempotent. Mirrors the C# `DisposeAsync`.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Tear the circuit down if it is still up (the relay finished / the far side
    // dropped). disconnect() is itself idempotent + a no-op when already down.
    this._circuit.disconnect();
    this.complete();
  }

  private fireData(data: Uint8Array): void {
    if (this.dataListeners.length === 0) {
      // No reader yet — buffer so a frame racing the connect-ack isn't lost; it is
      // flushed when the first onData listener attaches.
      this.inboundBuffer.push(data);
    } else {
      for (const cb of [...this.dataListeners]) {
        cb(data);
      }
    }
    // Tell the circuit the frame has been consumed so it can release choke if it
    // asserted backpressure (the synchronous-delivery seam — see onData).
    this._circuit.onDeliveryDrained();
  }

  private complete(): void {
    // Run exactly once. complete() can be reached twice — e.g. dispose() drives
    // circuit.disconnect() and calls complete() itself, and the circuit's own close
    // (the Disconnect Acknowledge) later fires circuit.onClosed → complete() again —
    // so guard so onClosed listeners + the completion promise settle once (the C#
    // class's idempotent TrySetResult / TryComplete).
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.resolveCompletion();
    for (const cb of [...this.closedListeners]) {
      cb();
    }
  }
}
