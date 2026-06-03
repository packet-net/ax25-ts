import { describe, expect, it, vi } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  decodeFrame,
  disc,
  dm,
  encodeFrame,
  getNr,
  getNs,
  iFrame,
  pollFinal,
  rr,
  sabm,
  ua,
} from "../src/frame.js";
import { Ax25Stack } from "../src/session.js";
import { MockTransport, pair } from "./mock-transport.js";

// A scripted "peer" that uses the raw MockTransport directly, without the
// full Ax25Stack. Lets us drive precise sequences of frames from the peer
// side while exercising the SUT's session state machine.
function peerSend(transport: MockTransport, frame: Ax25Frame): Promise<void> {
  return transport.send(encodeFrame(frame));
}

function setupPeer(transport: MockTransport): {
  frames: Ax25Frame[];
  flush: () => Promise<void>;
} {
  const frames: Ax25Frame[] = [];
  transport.start((bytes) => {
    try {
      frames.push(decodeFrame(bytes));
    } catch {
      // ignore — should not happen in tests
    }
  });
  return {
    frames,
    // Give microtasks a chance to fire.
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("Ax25Session — connect (SABM/UA round-trip)", () => {
  it("sends SABM, sees UA, returns the session", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("M0LTE-2");
    const remote = Callsign.parse("G7XYZ-1");

    const connectPromise = stack.connect({ from: local, to: remote });

    // Wait for the SABM to land on the peer.
    await peer.flush();
    expect(peer.frames.length).toBe(1);
    expect(classify(peer.frames[0]!)).toBe("SABM");

    // Reply UA.
    await peerSend(
      b,
      ua({
        destination: local,
        source: remote,
        finalBit: pollFinal(peer.frames[0]!),
      }),
    );

    const session = await connectPromise;
    expect(session.from.toString()).toBe("M0LTE-2");
    expect(session.to.toString()).toBe("G7XYZ-1");
    await stack.stop();
  });

  it("rejects the connect promise on peer DM", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("A");
    const remote = Callsign.parse("B");
    const connectPromise = stack.connect({ from: local, to: remote });
    await peer.flush();
    // Reply DM.
    const { dm } = await import("../src/frame.js");
    await peerSend(b, dm({ destination: local, source: remote, finalBit: true }));

    await expect(connectPromise).rejects.toThrow(/refused connection/);
    await stack.stop();
  });

  it("retries SABM on T1 timeout up to N2 then rejects", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("A");
    const remote = Callsign.parse("B");

    const connectPromise = stack
      .connect({
        from: local,
        to: remote,
        options: { t1Ms: 5, n2: 2 },
      })
      .catch((e) => e);

    // Let T1 fire enough times to exhaust N2.
    await new Promise((r) => setTimeout(r, 50));
    const err = (await connectPromise) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/retry limit/);
    // At least the initial SABM + at least one retry should have landed.
    const sabms = peer.frames.filter((f) => classify(f) === "SABM");
    expect(sabms.length).toBeGreaterThanOrEqual(2);
    await stack.stop();
  });
});

describe("Ax25Session — I-frame TX/RX", () => {
  it("emits I-frame on write() with N(S)=0, N(R)=0", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("M0LTE-2");
    const remote = Callsign.parse("G7XYZ-1");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    const session = await cp;
    peer.frames.length = 0; // reset for clarity

    await session.write(new TextEncoder().encode("hi"));
    await peer.flush();

    const iframes = peer.frames.filter((f) => classify(f) === "I");
    expect(iframes.length).toBe(1);
    expect(getNs(iframes[0]!)).toBe(0);
    expect(getNr(iframes[0]!)).toBe(0);
    expect(new TextDecoder().decode(iframes[0]!.info)).toBe("hi");
    await stack.stop();
  });

  it("delivers inbound I-frame info via onData and acks with RR(N(R)=1)", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("M0LTE-2");
    const remote = Callsign.parse("G7XYZ-1");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    const session = await cp;
    peer.frames.length = 0;

    const received: Uint8Array[] = [];
    session.onData((chunk) => received.push(chunk));

    // Peer sends I with N(S)=0, N(R)=0, "hello".
    await peerSend(
      b,
      iFrame({
        destination: local,
        source: remote,
        nr: 0,
        ns: 0,
        info: new TextEncoder().encode("hello"),
        pollBit: true,
      }),
    );
    await peer.flush();
    await peer.flush();

    expect(received.length).toBe(1);
    expect(new TextDecoder().decode(received[0]!)).toBe("hello");

    // Our reply should be an RR with N(R) = 1 (we received N(s)=0).
    const rrs = peer.frames.filter((f) => classify(f) === "RR");
    expect(rrs.length).toBeGreaterThanOrEqual(1);
    expect(getNr(rrs[rrs.length - 1]!)).toBe(1);
    await stack.stop();
  });

  it("re-establishes on a spec-violating info-bearing DM (DL-ERROR M, classifier parity)", async () => {
    // The Ax25Stack/Ax25Session receive path runs every inbound frame through
    // classifyFrame (mirroring the C# Ax25Adapter). A DM carrying a trailing
    // info byte is malformed (§3.5): the classifier maps it to
    // info_not_permitted_in_frame, and Connected t10 raises DL-ERROR (M) and
    // re-establishes — rather than the malformed DM being processed as a plain
    // DM (which would silently tear the link down).
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("M0LTE-2");
    const remote = Callsign.parse("G7XYZ-1");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(b, ua({ destination: local, source: remote, finalBit: true }));
    await cp;
    peer.frames.length = 0;

    // Peer sends a DM with a trailing (illegal) info octet — raw bytes so the
    // lenient decode keeps the info field for the classifier.
    const dmBytes = encodeFrame(dm({ destination: local, source: remote }));
    const malformed = new Uint8Array(dmBytes.length + 1);
    malformed.set(dmBytes, 0);
    malformed[dmBytes.length] = 0x99;
    await b.send(malformed);
    await peer.flush();
    await peer.flush();

    // The error path re-establishes: a fresh SABM goes out (Establish_Data_Link).
    const sabms = peer.frames.filter((f) => classify(f) === "SABM");
    expect(sabms.length).toBeGreaterThanOrEqual(1);
    await stack.stop();
  });

  it("advances V(a) on a peer RR ack and pumps the next queued frame", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("A");
    const remote = Callsign.parse("B");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    const session = await cp;
    peer.frames.length = 0;

    // Queue 2 frames in quick succession.
    await session.write(new Uint8Array([1]));
    await session.write(new Uint8Array([2]));
    await peer.flush();

    // Only the first should have gone out (k=1 window).
    let iframes = peer.frames.filter((f) => classify(f) === "I");
    expect(iframes.length).toBe(1);
    expect(getNs(iframes[0]!)).toBe(0);

    // Peer acks N(S)=0 by sending RR with N(R)=1.
    await peerSend(
      b,
      rr({
        destination: local,
        source: remote,
        nr: 1,
        isCommand: false,
        pollFinal: false,
      }),
    );
    await peer.flush();
    await peer.flush();

    iframes = peer.frames.filter((f) => classify(f) === "I");
    expect(iframes.length).toBe(2);
    expect(getNs(iframes[1]!)).toBe(1);
    await stack.stop();
  });
});

describe("Ax25Session — disconnect (DISC/UA round-trip)", () => {
  it("sends DISC, sees UA, resolves disconnect(), invokes onDisconnected", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("A");
    const remote = Callsign.parse("B");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    const session = await cp;
    peer.frames.length = 0;

    const onDisc = vi.fn();
    session.onDisconnected(onDisc);
    const dp = session.disconnect();
    await peer.flush();

    const discs = peer.frames.filter((f) => classify(f) === "DISC");
    expect(discs.length).toBe(1);

    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    await dp;
    expect(onDisc).toHaveBeenCalled();
    await stack.stop();
  });

  it("handles peer-initiated DISC while Connected", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const local = Callsign.parse("A");
    const remote = Callsign.parse("B");
    const cp = stack.connect({ from: local, to: remote, options: { t1Ms: 1000 } });
    await peer.flush();
    await peerSend(
      b,
      ua({ destination: local, source: remote, finalBit: true }),
    );
    const session = await cp;
    peer.frames.length = 0;

    const onDisc = vi.fn();
    session.onDisconnected(onDisc);

    // Peer sends DISC.
    await peerSend(b, disc({ destination: local, source: remote }));
    await peer.flush();
    await peer.flush();

    // We should reply UA.
    const uas = peer.frames.filter((f) => classify(f) === "UA");
    expect(uas.length).toBe(1);
    expect(onDisc).toHaveBeenCalled();
    await stack.stop();
  });
});

describe("Ax25Stack — sanity", () => {
  it("throws if connect() is called before start()", async () => {
    const { a } = pair();
    const stack = new Ax25Stack(a);
    await expect(
      stack.connect({ from: "A", to: "B" }),
    ).rejects.toThrow(/not started/);
  });

  it("throws if `via` digipeaters are provided (not implemented)", async () => {
    const { a } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    await expect(
      stack.connect({ from: "A", to: "B", via: ["G8BPQ"] }),
    ).rejects.toThrow(/not implemented/);
    await stack.stop();
  });

  it("accepts string callsigns and parses them", async () => {
    const { a, b } = pair();
    const stack = new Ax25Stack(a);
    await stack.start();
    const peer = setupPeer(b);

    const cp = stack.connect({
      from: "M0LTE-2",
      to: "G7XYZ",
      options: { t1Ms: 1000 },
    });
    await peer.flush();
    expect(peer.frames.length).toBe(1);
    expect(peer.frames[0]!.source.callsign.toString()).toBe("M0LTE-2");
    expect(peer.frames[0]!.destination.callsign.toString()).toBe("G7XYZ");

    await peerSend(
      b,
      ua({
        destination: Callsign.parse("M0LTE-2"),
        source: Callsign.parse("G7XYZ"),
        finalBit: true,
      }),
    );
    await cp;
    await stack.stop();
  });
});
