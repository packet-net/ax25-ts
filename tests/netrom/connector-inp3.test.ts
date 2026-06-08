/**
 * INP3 live host-wiring in {@link NetRomConnector} — the TS analogue of the C#
 * `NetRomServiceInp3Tests`. Proves the connector's overlay glue end-to-end without two
 * real listeners: a controllable fake interlink lets us drive inbound 0xCF (RIF / L3RTT)
 * into the connector's tap and capture the outbound frames the engine/scheduler emit.
 *
 * The host-free protocol logic (codecs, SNTT, engine, selector, scheduler, table
 * ingest/build) is exhaustively unit-tested in its own modules; these tests cover only
 * the WIRING: the inbound RIF/L3RTT dispatch ahead of L4, the engine driven by `tick()`,
 * the shared-table RIF ingest, and the default-off guarantee.
 */
import { describe, expect, it } from "vitest";
import {
  type Inp3Rif,
  Inp3L3RttFrame,
  inp3RifToBytes,
  NetRomConnector,
  NetRomRoutingTable,
  resolveDestination,
} from "../../src/netrom/index.js";
import { Callsign } from "../../src/callsign.js";
import { PID_NET_ROM } from "../../src/frame.js";
import type { Ax25ListenerSession } from "../../src/listener.js";
import type { DataLinkSignal } from "../../src/sdl/action-dispatcher.js";

const A = new Callsign("GB7AAA", 0); // our node
const B = new Callsign("GB7RDG", 0); // an interlink neighbour
const SOT = new Callsign("GB7SOT", 0); // a destination B advertises

/** A drivable interlink session: the connector taps `onDataLinkSignal`; the test fires
 *  inbound 0xCF datagrams via {@link deliver}. */
class FakeSession {
  state = "Connected";
  private cb: ((sig: DataLinkSignal) => void) | null = null;
  constructor(public readonly to: Callsign) {}
  onDataLinkSignal(cb: (sig: DataLinkSignal) => void): void {
    this.cb = cb;
  }
  deliver(data: Uint8Array): void {
    this.cb?.({ type: "DL_DATA_indication", pid: PID_NET_ROM, data } as DataLinkSignal);
  }
}

/** A fake {@link NetRomInterlinkListener}: records outbound `sendData`, and lets the test
 *  inject an inbound interlink session (a remote dialling us) via {@link accept}. */
class FakeListener {
  readonly sent: { to: string; bytes: Uint8Array }[] = [];
  private acceptCb: ((s: Ax25ListenerSession) => void) | null = null;
  onSessionAccepted(cb: (s: Ax25ListenerSession) => void): void {
    this.acceptCb = cb;
  }
  accept(session: FakeSession): void {
    this.acceptCb?.(session as unknown as Ax25ListenerSession);
  }
  connect(neighbour: Callsign): Promise<Ax25ListenerSession> {
    return Promise.resolve(new FakeSession(neighbour) as unknown as Ax25ListenerSession);
  }
  sendData(session: Ax25ListenerSession, bytes: Uint8Array, _pid: number): void {
    this.sent.push({ to: session.to.toString(), bytes: bytes.slice() });
  }
}

function rifBytes(dest: Callsign, hopCount: number, targetTimeMs: number): Uint8Array {
  const rif: Inp3Rif = {
    rips: [{ destination: dest, hopCount, targetTimeMs, tlvs: [] }],
  };
  return inp3RifToBytes(rif);
}

/** Wire a connector + the shared table + a tapped interlink session from neighbour B,
 *  with a controllable clock. INP3 on unless `inp3:false`. `rifIntervalMs` lets a test
 *  compress the periodic cadence so a periodic fan-out fires BEFORE the 180 s reflection
 *  reset window would tear the neighbour down (the C# `FastRif` trick). */
function setup(opts: { inp3?: boolean; rifIntervalMs?: number } = {}) {
  const inp3On = opts.inp3 ?? true;
  let nowMs = 100_000;
  const now = () => nowMs;
  const table = new NetRomRoutingTable(undefined, now);
  const listener = new FakeListener();
  const overlay = {
    enabled: true,
    ...(opts.rifIntervalMs !== undefined
      ? { rifIntervalMs: opts.rifIntervalMs, positiveDebounceMs: 1_000 }
      : {}),
  };
  const connector = new NetRomConnector(
    { snapshot: () => table.snapshot() },
    {
      enabled: true,
      now,
      ...(inp3On ? { inp3: { table, options: overlay } } : {}),
    },
  );
  connector.attachPort("p1", A, listener);
  const session = new FakeSession(B);
  listener.accept(session); // the connector now taps this interlink session
  return {
    table,
    listener,
    connector,
    session,
    advance: (ms: number) => {
      nowMs += ms;
    },
    l3rtts: () =>
      listener.sent
        .map((s) => ({ to: s.to, frame: Inp3L3RttFrame.tryParse(s.bytes) }))
        .filter((x) => x.frame !== null),
    rifsSent: () => listener.sent.filter((s) => s.bytes.length >= 1 && s.bytes[0] === 0xff),
  };
}

/** Measure the A↔B link to `rttMs`/2 SNTT through the real wiring: B probes us (observe +
 *  capability + we reflect), we tick (our probe out), advance the clock, reflect our probe
 *  back. Leaves the engine's SNTT(B) = rttMs/2 and B INP3-capable. */
function measure(h: ReturnType<typeof setup>, rttMs: number): void {
  h.session.deliver(Inp3L3RttFrame.build(B).toBytes()); // a peer probe from B
  h.listener.sent.length = 0;
  h.connector.tick(); // sends OUR probe to B (first tick → never-probed)
  const ourProbe = h.listener.sent.find(
    (s) => s.to === B.toString() && Inp3L3RttFrame.tryParse(s.bytes)?.packet.network.origin.equals(A),
  );
  if (ourProbe === undefined) throw new Error("expected our probe to B on the first tick");
  h.advance(rttMs);
  h.session.deliver(ourProbe.bytes); // B reflects our probe verbatim → SNTT sample
}

describe("NetRomConnector — INP3 live host wiring", () => {
  it("probes an observed interlink neighbour on tick (an L3RTT to it on the wire)", () => {
    const h = setup();
    h.session.deliver(Inp3L3RttFrame.build(B).toBytes()); // observe B (+ we reflect)
    h.listener.sent.length = 0;

    h.connector.tick();

    const ours = h.l3rtts().filter(
      (x) => x.to === B.toString() && x.frame!.packet.network.origin.equals(A),
    );
    expect(ours.length).toBeGreaterThan(0);
    h.connector.dispose();
  });

  it("ingests an inbound RIF as a time-route once the link is measured", () => {
    const h = setup();
    measure(h, 100); // SNTT(B) = 50

    h.session.deliver(rifBytes(SOT, 1, 100)); // B advertises SOT, target 100, hop 1

    const dest = resolveDestination(h.table.snapshot(), SOT.toString());
    expect(dest).not.toBeNull();
    const route = dest!.routes.find((r) => r.neighbour.equals(B));
    expect(route?.inp3).toBeDefined();
    // local target time = 100 (peer) + 50 (SNTT) + 10 (per-hop)
    expect(route!.inp3!.targetTimeMs).toBe(160);
    expect(route!.inp3!.hopCount).toBe(2);
    h.connector.dispose();
  });

  it("an inbound RIF is consumed by the overlay, never re-emitted as a forwarded L4 datagram", () => {
    const h = setup();
    measure(h, 100);
    h.listener.sent.length = 0;

    h.session.deliver(rifBytes(SOT, 1, 100));

    // Nothing non-INP3 went back on the wire (a RIF is ingested, not forwarded).
    const nonInp3 = h.listener.sent.filter(
      (s) => Inp3L3RttFrame.tryParse(s.bytes) === null && !(s.bytes[0] === 0xff),
    );
    expect(nonInp3).toHaveLength(0);
    expect(resolveDestination(h.table.snapshot(), SOT.toString())).not.toBeNull();
    h.connector.dispose();
  });

  it("after learning a time-route, a tick fans out a RIF to the capable neighbour", () => {
    const h = setup({ rifIntervalMs: 5_000 }); // compressed cadence (< the 180 s reset)
    measure(h, 100);
    h.session.deliver(rifBytes(SOT, 1, 100)); // learn SOT via B
    h.listener.sent.length = 0;

    // Advance past the (compressed) periodic RIF interval but well under the 180 s
    // reflection-reset window (so B stays alive), then tick → a RIF fan-out to B.
    h.advance(6_000);
    h.connector.tick();

    expect(h.rifsSent().some((s) => s.to === B.toString())).toBe(true);
    h.connector.dispose();
  });

  // ─── default-off guarantee ───

  it("with the overlay off, a RIF-shaped frame is not ingested and nothing is emitted", () => {
    const h = setup({ inp3: false });
    h.session.deliver(rifBytes(SOT, 1, 100));
    h.connector.tick();

    expect(resolveDestination(h.table.snapshot(), SOT.toString())).toBeNull();
    expect(h.listener.sent).toHaveLength(0);
    h.connector.dispose();
  });
});
