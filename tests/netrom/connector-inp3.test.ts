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

// ─── per-port INP3 selected-link gate (two ports, same neighbour) ───
//
// The single-port `setup()` above never fires the (portId, callsign) gate in
// dispatchInp3 / the interlinkForCallsign send seam, because a callsign only has
// one interlink. These wire B on TWO ports and prove routing information is
// ingested/sent only over the selected link.

const SOT2 = new Callsign("GB7XXX", 0); // a second destination B advertises

/** Wire a connector with B tapped on BOTH p1 and p2, a controllable clock, and the
 *  shared table. Returns per-port listeners/sessions and a helper to seed the SNTT +
 *  B's own 0/0 self-route on p1 (which makes p1 the routing-selected port for B). */
function setupTwoPort() {
  let nowMs = 100_000;
  const now = () => nowMs;
  const table = new NetRomRoutingTable(undefined, now);
  const l1 = new FakeListener();
  const l2 = new FakeListener();
  const connector = new NetRomConnector(
    { snapshot: () => table.snapshot() },
    { enabled: true, now, inp3: { table, options: { enabled: true, rifIntervalMs: 5_000, positiveDebounceMs: 1_000 } } },
  );
  connector.attachPort("p1", A, l1);
  connector.attachPort("p2", A, l2);
  const s1 = new FakeSession(B);
  const s2 = new FakeSession(B);
  l1.accept(s1); // B on p1
  l2.accept(s2); // the same callsign B, a second interlink on p2
  const advance = (ms: number) => { nowMs += ms; };
  const selectPort1 = () => {
    // Measure the A↔B link on p1 so ingest has an SNTT for B (engine is callsign-keyed).
    s1.deliver(Inp3L3RttFrame.build(B).toBytes());
    connector.tick();
    const ourProbe = l1.sent.find(
      (s) => s.to === B.toString() && Inp3L3RttFrame.tryParse(s.bytes)?.packet.network.origin.equals(A),
    );
    if (ourProbe === undefined) throw new Error("expected our probe to B on p1");
    advance(100);
    s1.deliver(ourProbe.bytes); // reflect → SNTT(B) = 50
    // B's own 0/0 RIP arriving on p1: a route to B *via B* on p1, so routing's
    // selected interlink port for B is p1 (chosenInterlinkPort's self-route branch).
    s1.deliver(rifBytes(B, 0, 0));
    l1.sent.length = 0;
    l2.sent.length = 0;
  };
  return { table, connector, l1, l2, s1, s2, advance, selectPort1 };
}

describe("NetRomConnector - per-port INP3 selected-link gate", () => {
  it("ingests a RIF on the selected port but DROPS the same neighbour's RIF on another port", () => {
    const h = setupTwoPort();
    h.selectPort1(); // p1 is now B's selected interlink port

    // A RIF from B on p2 (the NON-selected port) must be dropped, not ingested.
    h.s2.deliver(rifBytes(SOT2, 1, 100));
    expect(resolveDestination(h.table.snapshot(), SOT2.toString())).toBeNull();

    // The identical RIF on p1 (the selected port) IS ingested.
    h.s1.deliver(rifBytes(SOT2, 1, 100));
    const dest = resolveDestination(h.table.snapshot(), SOT2.toString());
    expect(dest).not.toBeNull();
    expect(dest!.routes.some((r) => r.neighbour.equals(B) && r.portId === "p1")).toBe(true);
    // and nothing landed a route to SOT2 on p2.
    expect(dest!.routes.some((r) => r.portId === "p2")).toBe(false);
    h.connector.dispose();
  });

  it("fans a periodic RIF out over the selected interlink only (interlinkForCallsign)", () => {
    const h = setupTwoPort();
    h.selectPort1();
    h.s1.deliver(rifBytes(SOT, 1, 100)); // learn a time-route so there is something to advertise
    h.l1.sent.length = 0;
    h.l2.sent.length = 0;

    h.advance(6_000); // past the compressed RIF interval, well under the 180 s reset
    h.connector.tick();

    const rifTo = (l: FakeListener) => l.sent.filter((s) => s.to === B.toString() && s.bytes[0] === 0xff);
    expect(rifTo(h.l1).length).toBeGreaterThan(0); // fanned out over the selected port
    expect(rifTo(h.l2)).toHaveLength(0); // never over the non-selected interlink to the same callsign
    h.connector.dispose();
  });
});
