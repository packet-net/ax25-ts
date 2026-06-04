/**
 * The read-only "NET/ROM aware" slice end-to-end through the production
 * pipeline: a real {@link Ax25Listener} over a {@link LoopbackTransport}, with a
 * {@link NetRomService} subscribed to its frame-trace tap. A third station
 * broadcasts a NODES routing frame (UI, PID 0xCF, dest `NODES`); the service
 * hears it on the tap — which fires *before* the listener's address filter, so a
 * NODES frame addressed to the literal `NODES` (not to us) is heard — builds a
 * routing table, and surfaces it via `snapshot()`. And it is proven unable to
 * disturb a live session while doing so.
 *
 * TS port of `tests/Packet.Node.Tests/Integration/NetRomAwareIntegrationTests.cs`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { classify, iFrame, sabm } from "../../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../../src/listener.js";
import { NetRomService } from "../../src/netrom/index.js";
import {
  LoopbackTransport,
  waitFor,
  withTimeout,
} from "../listener-test-support.js";
import { buildNodesFrame, buildNodesInfo } from "../netrom-builder.js";

const NodeCall = Callsign.parse("M0NODE"); // us — the listening node
const Neighbour = Callsign.parse("GB7RDG"); // the NODES broadcaster
const DestSot = Callsign.parse("GB7SOT"); // a destination it advertises
const ViaXyz = Callsign.parse("GB7XYZ-2"); // its chosen best-neighbour for SOT
const Peer = Callsign.parse("M0RMOT"); // an actual QSO peer

/** Inject a genuine NODES broadcast (UI, PID 0xCF, dest "NODES") onto the wire. */
function broadcastNodes(transport: LoopbackTransport): void {
  const info = buildNodesInfo("RDGBPQ", [
    { dest: DestSot, destAlias: "SOT", neighbour: ViaXyz, quality: 200 },
  ]);
  transport.injectInbound(buildNodesFrame(Neighbour, info));
}

describe("NetRomService — read-only NODES ingest", () => {
  it("hears a NODES broadcast on the tap and learns the routes", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);
    await listener.start();

    // GB7RDG (alias RDGBPQ) broadcasts: it can reach GB7SOT (alias SOT) via
    // GB7XYZ-2 at quality 200. The frame is addressed to "NODES", not to us —
    // so it's heard only because the tap fires before address filtering.
    broadcastNodes(transport);

    await waitFor(() => netRom.snapshot().neighbours.length > 0, 2000, "should hear NODES");

    const snap = netRom.snapshot();
    expect(snap.neighbours).toHaveLength(1);
    expect(snap.neighbours[0]!.neighbour.equals(Neighbour)).toBe(true);
    expect(snap.neighbours[0]!.alias).toBe("RDGBPQ");
    expect(snap.neighbours[0]!.portId).toBe("p1");

    // Two destinations: the assumed direct route to GB7RDG, and GB7SOT via it.
    expect(snap.destinations.some((d) => d.destination.equals(Neighbour))).toBe(true);
    const sot = snap.destinations.find((d) => d.destination.equals(DestSot));
    expect(sot).toBeDefined();
    expect(sot!.alias).toBe("SOT");
    expect(sot!.bestRoute!.neighbour.equals(Neighbour)).toBe(true); // we forward to the broadcaster

    await listener.dispose();
  });

  it("does NOT create an AX.25 session for the NODES broadcaster (observation only)", async () => {
    // The tap is observation-only — hearing a NODES frame must not open or
    // disturb any session. The listener address-filters the NODES frame out
    // (it's addressed to "NODES", not to us), so no sessionAccepted ever fires.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);

    let sessionAccepted = 0;
    listener.onSessionAccepted(() => sessionAccepted++);
    await listener.start();

    broadcastNodes(transport);
    await waitFor(() => netRom.snapshot().neighbours.length > 0, 2000);

    // Brief settle, then assert no session was built and nothing was transmitted.
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionAccepted).toBe(0);
    expect(transport.outboundCount).toBe(0); // a pure receiver transmits nothing

    await listener.dispose();
  });

  it("a NODES storm does not disturb a live QSO (the read-only guarantee)", async () => {
    // Connect a real inbound session, then storm the channel with NODES
    // broadcasts while connected, and confirm the link is still Connected and
    // still carries data afterwards.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);

    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted(resolve);
    });
    await listener.start();

    // Establish the QSO: peer SABM → our UA → Connected.
    transport.injectInbound(sabm({ destination: NodeCall, source: Peer }));
    const session = await withTimeout(accepted, 2000, "sessionAccepted");
    await waitFor(() => session.state === "Connected", 2000);
    expect(session.state).toBe("Connected");

    const received: Uint8Array[] = [];
    session.onData((chunk) => received.push(chunk));

    // Storm the channel with NODES broadcasts while connected.
    for (let i = 0; i < 5; i++) {
      broadcastNodes(transport);
    }
    await waitFor(() => netRom.snapshot().neighbours.length > 0, 2000, "still hears NODES while in a QSO");

    // The session is unperturbed: still Connected, and a fresh inbound I-frame
    // from the peer still arrives.
    expect(session.state).toBe("Connected");
    transport.injectInbound(
      iFrame({
        destination: NodeCall,
        source: Peer,
        ns: 0,
        nr: 0,
        info: new TextEncoder().encode("still here"),
        pid: 0xf0,
        pollBit: false,
      }),
    );
    await waitFor(() => received.length >= 1, 2000, "the QSO still carries data after the NODES storm");
    expect(new TextDecoder().decode(received[0]!)).toBe("still here");

    await listener.dispose();
  });
});

describe("NetRomService — lifecycle + disabled", () => {
  it("a disabled service hears nothing and snapshot is always empty", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService({ enabled: false });
    netRom.attachPort("p1", NodeCall, listener); // no-op when disabled
    await listener.start();

    for (let i = 0; i < 3; i++) {
      broadcastNodes(transport);
    }
    await new Promise((r) => setTimeout(r, 100));

    expect(netRom.enabled).toBe(false);
    expect(netRom.attachedPorts).toHaveLength(0);
    expect(netRom.snapshot().neighbours).toHaveLength(0);
    expect(netRom.snapshot().destinations).toHaveLength(0);

    await listener.dispose();
  });

  it("detachPort unsubscribes the tap; learned routes survive", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);
    await listener.start();

    broadcastNodes(transport);
    await waitFor(() => netRom.snapshot().neighbours.length > 0, 2000);
    const before = netRom.snapshot().neighbours.length;

    netRom.detachPort("p1");
    expect(netRom.attachedPorts).toHaveLength(0);

    // Further broadcasts are not heard (tap unsubscribed), but the already-learned
    // table is untouched.
    broadcastNodes(transport);
    await new Promise((r) => setTimeout(r, 50));
    expect(netRom.snapshot().neighbours.length).toBe(before);

    await listener.dispose();
  });

  it("dispose detaches every port", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);
    await listener.start();

    netRom.dispose();
    expect(netRom.attachedPorts).toHaveLength(0);

    // After dispose, a NODES broadcast is no longer ingested.
    broadcastNodes(transport);
    await new Promise((r) => setTimeout(r, 50));
    expect(netRom.snapshot().neighbours).toHaveLength(0);

    await listener.dispose();
  });

  it("a NODES frame the parser rejects is ignored without disturbing anything", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: NodeCall });
    const netRom = new NetRomService();
    netRom.attachPort("p1", NodeCall, listener);
    await listener.start();

    // A UI frame to "NODES" with PID 0xCF but a non-0xFF signature byte — the
    // canonical "wrong signature → ignore". The tap parses it, gets null, and
    // ignores it; nothing is learned.
    const badInfo = buildNodesInfo("RDGBPQ");
    badInfo[0] = 0x00;
    transport.injectInbound(buildNodesFrame(Neighbour, badInfo));
    await new Promise((r) => setTimeout(r, 50));
    expect(netRom.snapshot().neighbours).toHaveLength(0);

    // And a non-NET/ROM UI frame to a different dest is likewise not learned.
    transport.injectInbound(
      iFrame({
        destination: NodeCall,
        source: Peer,
        ns: 0,
        nr: 0,
        info: new TextEncoder().encode("not netrom"),
        pid: 0xf0,
        pollBit: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(netRom.snapshot().neighbours).toHaveLength(0);

    // Sanity: classify still sees the injected NODES frame as a UI frame (the
    // gate that matters is the signature, not the frame kind).
    expect(classify(buildNodesFrame(Neighbour, buildNodesInfo("X")))).toBe("UI");

    await listener.dispose();
  });
});
