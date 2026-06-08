import { Callsign } from "../callsign.js";
import { PID_NET_ROM, classify } from "../frame.js";
import type {
  Ax25FrameTracedEvent,
  Ax25Listener,
} from "../listener.js";
import {
  NETROM_PARSE_LENIENT,
  NODES_DESTINATION,
  type NetRomParseOptions,
  parseNodesBroadcast,
} from "./nodes-broadcast.js";
import {
  EMPTY_NETROM_SNAPSHOT,
  NETROM_ROUTING_DEFAULTS,
  NetRomRoutingTable,
  type NetRomRoutingOptions,
  type NetRomRoutingSnapshot,
} from "./routing-table.js";

/**
 * Construction options for {@link NetRomService}. Every field is optional; the
 * defaults make a stock service NET/ROM-aware out of the box (hearing NODES is
 * free and harmless).
 *
 * Mirrors the relevant fields of the C# `NetRomConfig` + `NetRomService`
 * constructor.
 */
export interface NetRomServiceOptions {
  /**
   * Whether to listen for NODES broadcasts and maintain the routing table.
   * Default `true` (read-only, harmless). Set `false` to make the service deaf
   * to NET/ROM entirely — {@link NetRomService.attachPort} becomes a no-op and
   * {@link NetRomService.snapshot} always returns the empty snapshot.
   */
  enabled?: boolean;
  /**
   * Route-maintenance knobs (quality floors, OBSINIT, table caps). Defaults to
   * {@link NETROM_ROUTING_DEFAULTS}. Individual fields can be overridden; any
   * omitted field falls back to the canonical default.
   */
  routing?: Partial<NetRomRoutingOptions>;
  /**
   * The {@link NetRomParseOptions} applied to every heard NODES info field.
   * Defaults to {@link NETROM_PARSE_LENIENT} — read-only promiscuous ingest wants
   * to be forgiving of a padded / clipped third-party dump. Pass
   * `NETROM_PARSE_STRICT` (or a peer preset) to be choosier.
   */
  parse?: NetRomParseOptions;
  /**
   * Injected clock returning epoch ms — the TS analogue of the C# `TimeProvider`.
   * Used for neighbour last-heard stamps so tests can drive time deterministically.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional sink for tap-handler exceptions. The frame tap is wrapped in
   * try/catch so a malformed frame can never propagate into the listener's
   * trace fan-out; anything unexpected goes here. Defaults to a no-op (a
   * read-only consumer swallows quietly).
   */
  onTapError?: (err: unknown) => void;
}

/** The set of methods {@link NetRomService} uses from an {@link Ax25Listener}. */
type FrameTapSource = Pick<Ax25Listener, "onFrameTraced" | "offFrameTraced">;

interface Attachment {
  readonly myCall: Callsign;
  readonly listener: FrameTapSource;
  readonly handler: (e: Ax25FrameTracedEvent) => void;
}

/**
 * The node-level NET/ROM service: hears NODES routing broadcasts on every
 * attached AX.25 port and maintains a {@link NetRomRoutingTable}. This is the
 * read-only "NET/ROM aware" slice — it parses what it hears, builds routes, and
 * surfaces them via {@link snapshot}; it **originates nothing on the air**.
 *
 * **It cannot disturb a session.** The only thing it touches on a port is the
 * existing {@link Ax25Listener.onFrameTraced} event — a pure observation tap that
 * fires for every parsed inbound frame *before* address filtering (so it hears
 * NODES broadcasts, which are addressed to the literal callsign `NODES`, not to
 * us) and never gates, delays, or alters frame handling. The handler only reads;
 * it sends nothing and posts nothing into any session. A throw in the handler is
 * isolated by the listener's per-subscriber guard *and* by this service's own
 * try/catch, but the handler is written not to throw regardless.
 *
 * Call {@link attachPort} as each port comes up and {@link detachPort} as it goes
 * down, so the service follows the live port set without holding a listener
 * reference past teardown. {@link sweep} (e.g. on a timer at the NODES broadcast
 * interval) ages routes out via the obsolescence count.
 *
 * Mirrors `Packet.Node.Core.NetRom.NetRomService` + `INetRomRoutingView` on the
 * C# side. (The C# service owns its own `TimeProvider`-driven sweep timer; in TS
 * the timer is left to the embedder — call {@link sweep} from a `setInterval` —
 * so the library stays free of ambient timers and trivially testable.)
 */
export class NetRomService {
  private readonly enabledFlag: boolean;
  private readonly parseOptions: NetRomParseOptions;
  private readonly onTapError: (err: unknown) => void;
  private readonly table: NetRomRoutingTable;
  private readonly attachments = new Map<string, Attachment>();
  private disposed = false;

  constructor(options: NetRomServiceOptions = {}) {
    this.enabledFlag = options.enabled ?? true;
    this.parseOptions = options.parse ?? NETROM_PARSE_LENIENT;
    this.onTapError = options.onTapError ?? (() => {});
    const routing: NetRomRoutingOptions = {
      ...NETROM_ROUTING_DEFAULTS,
      ...options.routing,
    };
    this.table = new NetRomRoutingTable(routing, options.now ?? Date.now);
  }

  /**
   * True if NET/ROM awareness is enabled on this service. When false, the
   * snapshot is always empty and {@link attachPort} is a no-op.
   */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * The live, writable routing table backing this service — the same table the
   * NODES tap ingests into. Exposed so a host that runs the INP3 overlay can share
   * one table between NODES (quality) ingest here and RIF (time) ingest in the
   * {@link NetRomConnector} (`inp3.table`), exactly as the C# `NetRomService` owns
   * one table for both metric spaces. Read-only consumers should prefer
   * {@link snapshot}; this is the write handle for the connector's INP3 host wiring.
   */
  get routingTable(): NetRomRoutingTable {
    return this.table;
  }

  /** Port ids currently attached (hearing NODES). */
  get attachedPorts(): readonly string[] {
    return [...this.attachments.keys()];
  }

  /**
   * Begin hearing NODES broadcasts on a port. Subscribes the listener's
   * {@link Ax25Listener.onFrameTraced} tap. No-op if NET/ROM is disabled, the
   * service is disposed, or the port is already attached.
   *
   * @param portId The port id (used for neighbour tracking + detach).
   * @param myCall The port's local callsign (for the trivial-loop guard).
   * @param listener The port's AX.25 listener.
   */
  attachPort(
    portId: string,
    myCall: Callsign | string,
    listener: FrameTapSource,
  ): void {
    if (!this.enabledFlag || this.disposed) {
      return;
    }
    if (this.attachments.has(portId)) {
      return; // already attached — leave the first
    }
    const call = typeof myCall === "string" ? Callsign.parse(myCall) : myCall;
    const handler = (e: Ax25FrameTracedEvent): void =>
      this.onFrameTraced(portId, call, e);
    this.attachments.set(portId, { myCall: call, listener, handler });
    listener.onFrameTraced(handler);
  }

  /**
   * Stop hearing NODES broadcasts on a port and unsubscribe its tap. No-op if the
   * port was not attached. Learned routes survive — a torn-down port doesn't wipe
   * the table; obsolescence ages its neighbours out naturally.
   */
  detachPort(portId: string): void {
    const attachment = this.attachments.get(portId);
    if (!attachment) {
      return;
    }
    this.attachments.delete(portId);
    attachment.listener.offFrameTraced(attachment.handler);
  }

  /**
   * Take an immutable, point-in-time snapshot of the learned routing table —
   * destinations with their best-first routes, plus directly-heard neighbours.
   * The empty snapshot when disabled. Nothing on this read side can transmit,
   * originate a NODES broadcast, or open a circuit.
   */
  snapshot(): NetRomRoutingSnapshot {
    return this.enabledFlag ? this.table.snapshot() : EMPTY_NETROM_SNAPSHOT;
  }

  /**
   * Age the routing table by one obsolescence tick (decrement every route's
   * count, purge those reaching 0). Call at the NODES broadcast interval.
   *
   * @returns The number of routes purged (0 when disabled).
   */
  sweep(): number {
    return this.enabledFlag ? this.table.sweep() : 0;
  }

  /** Detach every port and stop hearing. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const portId of [...this.attachments.keys()]) {
      this.detachPort(portId);
    }
  }

  // ─── The read-only tap ────────────────────────────────────────────

  private onFrameTraced(
    portId: string,
    myCall: Callsign,
    e: Ax25FrameTracedEvent,
  ): void {
    // Defensive: the listener already isolates a throwing subscriber, but a
    // read-only consumer must never be the reason a frame's trace fan-out
    // misbehaves. Swallow anything unexpected.
    try {
      // Only inbound frames carry NODES we should learn from; a TX trace (a
      // future write slice) must never feed our own table.
      if (e.direction !== "rx") {
        return;
      }
      const frame = e.frame;

      // NODES broadcasts are UI frames, PID 0xCF, AX.25 destination the literal
      // text callsign "NODES". Cheap gates first.
      if (classify(frame) !== "UI") {
        return;
      }
      if (frame.pid !== PID_NET_ROM) {
        return;
      }
      if (!isNodesDestination(frame.destination.callsign)) {
        return;
      }

      const broadcast = parseNodesBroadcast(frame.info, this.parseOptions);
      if (broadcast === null) {
        return; // unparseable NODES — ignore (canonical "wrong signature → ignore")
      }

      this.table.ingest(frame.source.callsign, myCall, portId, broadcast);
    } catch (err) {
      this.onTapError(err);
    }
  }
}

// The NODES destination is the literal text callsign "NODES" with SSID 0.
function isNodesDestination(dest: Callsign): boolean {
  return dest.ssid === 0 && dest.base === NODES_DESTINATION;
}
