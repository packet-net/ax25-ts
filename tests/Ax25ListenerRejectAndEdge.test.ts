/**
 * Reject-path and SDL edge-case coverage for {@link Ax25Listener}. TS
 * port of `tests/Packet.Ax25.Tests/Session/Ax25ListenerRejectAndEdgeTests.cs`,
 * including the post-#141 / #143 fix coverage at the bottom.
 *
 * "Edge case" here means inputs the listener has to route correctly
 * without crashing or building stray sessions: unknown peers sending
 * non-SABM frames, SABME, malformed SABM with the response bit set, and
 * SABM with a digipeater chain.
 */
import { describe, expect, it } from "vitest";
import { ADDRESS_ENCODED_LENGTH } from "../src/address.js";
import { Callsign } from "../src/callsign.js";
import {
  classify,
  disc,
  encodeFrame,
  iFrame,
  rr,
  sabm,
  sabme,
} from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCallA = Callsign.parse("G7XYZ-7");
const PeerCallB = Callsign.parse("M5ABC-3");

describe("Ax25Listener — reject path & spec edge cases", () => {
  // ─── Category 4: reject path ────────────────────────────────────────

  it("acceptIncoming=false emits DM to new peer", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    listener.acceptIncoming = false;

    let acceptFires = 0;
    listener.onSessionAccepted(() => acceptFires++);

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);

    expect(transport.decodedSent(0).control & 0xef).toBe(0x0f);
    expect(acceptFires).toBe(0);

    // Flip on and retry — must accept cleanly (no stale reject session).
    listener.acceptIncoming = true;
    const afterFlipAccepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => {
        if (s.context.remote.equals(PeerCallA)) resolve(s);
      });
    });

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    const session = await withTimeout(afterFlipAccepted, 2000, "afterFlipAccepted");
    expect(session.context.acceptIncoming).toBe(true);

    await listener.dispose();
  });

  it("acceptIncoming false then true accepts retry", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    listener.acceptIncoming = false;
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(0x0f);

    listener.acceptIncoming = true;
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(2, 2000);
    expect(transport.decodedSent(1).control & 0xef).toBe(0x63);

    const session = await withTimeout(accepted, 2000, "accepted");
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });

  it("acceptIncoming=false does not affect existing sessions", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });

    const aAccepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => {
        if (s.context.remote.equals(PeerCallA)) resolve(s);
      });
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    const sessionA = await withTimeout(aAccepted, 2000, "aAccepted");
    await transport.sentFrames.waitForCount(1, 2000);
    const uaCount = transport.sentFrames.count;

    listener.acceptIncoming = false;

    const aData: DataLinkSignal[] = [];
    sessionA.onDataLinkSignal((sig) => {
      if (sig.type === "DL_DATA_indication") aData.push(sig);
    });

    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCallA,
        nr: 0,
        ns: 0,
        info: new TextEncoder().encode("STILL-UP"),
        pollBit: false,
      }),
    );
    await waitFor(() => aData.length > 0, 2000);

    // Peer B (new) rejected — DM, no SessionAccepted.
    let bFired = false;
    listener.onSessionAccepted((s) => {
      if (s.context.remote.equals(PeerCallB)) bFired = true;
    });
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallB }));
    await transport.sentFrames.waitForCount(uaCount + 1, 2000);
    const reply = transport.decodedSent(transport.sentFrames.count - 1);
    expect(reply.control & 0xef).toBe(0x0f);

    await new Promise((r) => setTimeout(r, 100));
    expect(bFired).toBe(false);

    await listener.dispose();
  });

  // ─── Category 5: spec edge cases ────────────────────────────────────

  it("emits DM for DISC from an unknown peer (#143 carry-over)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let accepted = 0;
    listener.onSessionAccepted(() => accepted++);

    await listener.start();
    transport.injectInbound(disc({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);

    expect(accepted).toBe(0);
    expect(transport.sentFrames.count).toBe(1);
    const dm = transport.decodedSent(0);
    expect(dm.control & 0xef).toBe(0x0f);
    expect(dm.destination.callsign.equals(PeerCallA)).toBe(true);
    expect(dm.source.callsign.equals(LocalCall)).toBe(true);

    await listener.dispose();
  });

  it("emits DM for RR from an unknown peer (#143 carry-over, t05 all_other_commands)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let accepted = 0;
    listener.onSessionAccepted(() => accepted++);

    await listener.start();
    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCallA,
        nr: 0,
        isCommand: true,
      }),
    );
    await transport.sentFrames.waitForCount(1, 2000);

    expect(accepted).toBe(0);
    expect(transport.sentFrames.count).toBe(1);
    const dm = transport.decodedSent(0);
    expect(dm.control & 0xef).toBe(0x0f);
    expect(dm.destination.callsign.equals(PeerCallA)).toBe(true);

    await listener.dispose();
  });

  it("handles SABME from v2.2 peer (UA + isExtended=true)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();
    transport.injectInbound(sabme({ destination: LocalCall, source: PeerCallA }));

    const session = await withTimeout(accepted, 2000, "accepted");
    await transport.sentFrames.waitForCount(1, 2000);

    const reply = transport.decodedSent(0);
    expect(reply.control & 0xef).toBe(0x63);
    expect(session.context.isExtended).toBe(true);
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });

  it("handles malformed SABM with response C-bits — listener stays alive", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let observed: Ax25ListenerSession | null = null;
    const acceptedTcs = new Promise<boolean>((resolve) => {
      listener.onSessionAccepted((s) => {
        observed = s;
        resolve(true);
      });
      // Resolve falsey after a short settle if no event arrives.
      setTimeout(() => resolve(false), 500);
    });

    await listener.start();

    // Build a SABM, then flip dest+source C-bits before reinjecting.
    const normalSabm = sabm({ destination: LocalCall, source: PeerCallA });
    const bytes = encodeFrame(normalSabm);
    // Dest SSID byte at index 6; source SSID at index 13.
    bytes[6] = (bytes[6]! & 0x7f);       // clear destination C-bit (response)
    bytes[13] = (bytes[13]! | 0x80);     // set source C-bit
    transport.injectInboundBytes(bytes);

    const sawAccepted = await acceptedTcs;
    if (sawAccepted) {
      expect(observed).not.toBeNull();
      expect(observed!.state).toBe("Connected");
    } else {
      expect(observed).toBeNull();
    }
    // Invariant in both branches: listener stayed alive.
    expect(listener.isRunning).toBe(true);

    await listener.dispose();
  });

  it("handles SABM with a digipeater path (UA via reversed chain, #141 carry-over)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();

    const digi1 = Callsign.parse("GB7CIP");
    const digi2 = Callsign.parse("MB7UR");
    const sabmViaDigis = encodeFrame(
      sabm({
        destination: LocalCall,
        source: PeerCallA,
        digipeaters: [digi1, digi2],
      }),
    );
    // Mark both repeater slots has-been-repeated (section 3.12.4): this is the
    // copy the last digi put on the air, i.e. the one actually addressed to us. A
    // copy with H=0 is still in transit and is monitor-only (see
    // Ax25ListenerDigipeaterHBit.test.ts).
    sabmViaDigis[2 * ADDRESS_ENCODED_LENGTH + 6] |= 0x80;
    sabmViaDigis[3 * ADDRESS_ENCODED_LENGTH + 6] |= 0x80;
    transport.injectInboundBytes(sabmViaDigis);

    const session = await withTimeout(accepted, 2000, "accepted");
    expect(session.context.remote.equals(PeerCallA)).toBe(true);

    await transport.sentFrames.waitForCount(1, 2000);
    const ua = transport.decodedSent(0);
    expect(ua.control & 0xef).toBe(0x63);
    const replyDigis = ua.digipeaters.map((d) => d.callsign.toString());
    // Reversed chain — digi closest to responder first.
    expect(replyDigis).toEqual([digi2.toString(), digi1.toString()]);

    await listener.dispose();
  });

  // ─── Post-#141 / #143 fix coverage ──────────────────────────────────

  it("(#143) emits DM for I-frame from unknown peer", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let accepted = 0;
    listener.onSessionAccepted(() => accepted++);

    await listener.start();
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCallA,
        nr: 0,
        ns: 0,
        info: new TextEncoder().encode("HELLO"),
        pollBit: false,
      }),
    );

    await transport.sentFrames.waitForCount(1, 2000);
    expect(accepted).toBe(0);
    const dm = transport.decodedSent(0);
    expect(dm.control & 0xef).toBe(0x0f);
    expect(dm.destination.callsign.equals(PeerCallA)).toBe(true);

    await listener.dispose();
  });

  it("(#143) cache stays clean after non-SABM reject path", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    transport.injectInbound(disc({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);

    // Fresh inbound SABM must still fire sessionAccepted — proves no
    // transient session intercepted it.
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => {
        if (s.context.remote.equals(PeerCallA)) resolve(s);
      });
    });
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    const session = await withTimeout(accepted, 2000, "accepted");
    expect(session.state).toBe("Connected");

    await transport.sentFrames.waitForCount(2, 2000);
    expect(transport.sentFrames.count).toBe(2);
    // First DM (from DISC), then UA (from SABM).
    expect(transport.decodedSent(0).control & 0xef).toBe(0x0f);
    expect(transport.decodedSent(1).control & 0xef).toBe(0x63);
    void classify;

    await listener.dispose();
  });
});
