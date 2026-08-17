/**
 * Routing an extended (mod-128) supervisory frame on a listener whose
 * {@link Ax25ListenerOptions.parseOptions} reject an information field on an S
 * frame (`STRICT_PARSE`, and therefore `XROUTER_PARSE`).
 *
 * The inbound pump must parse before it can route, and cannot know the session
 * modulo until it has routed, so its routing parse is mod-8. An extended RR /
 * RNR / REJ / SREJ carries a 2-octet control field, and read at mod-8 the second
 * octet looks like an information field on an S frame, which section 3.5 does not
 * permit, so a strict parse rejects the whole frame. SABME and UA are U frames
 * (one octet in both modes), so the link came up and then every acknowledgement
 * was dropped before trace and dispatch (m0lte/packet.net#696). The pump now
 * retries the parse at mod-128, and accepts that reading only for a peer whose
 * cached session is already extended.
 *
 * TS port of packet.net's Ax25ListenerExtendedSupervisoryRoutingTests.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { STRICT_PARSE, rr, sabm, sabme } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");
const BUDGET_MS = 2000;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectExtendedInbound(
  listener: Ax25Listener,
  transport: LoopbackTransport,
): Promise<Ax25ListenerSession> {
  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted((s) => resolve(s));
  });

  await listener.start();
  transport.injectInbound(sabme({ destination: LocalCall, source: PeerCall }));

  const session = await withTimeout(accepted, BUDGET_MS, "accepted");
  await transport.sentFrames.waitForCount(1, BUDGET_MS);
  expect(session.state).toBe("Connected");
  expect(session.context.isExtended).toBe(true); // SABME opens a mod-128 link
  return session;
}

describe("extended supervisory routing on a strict listener (m0lte/packet.net#696)", () => {
  it("a strict listener delivers an extended supervisory frame on a SABME link", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      parseOptions: STRICT_PARSE,
    });

    const session = await connectExtendedInbound(listener, transport);

    let traced = 0;
    listener.onFrameTraced((e) => {
      if (e.direction === "rx") traced++;
    });

    // An RR command with P=1 is an enquiry: the SDL owes an S-frame response with
    // F=1. Before the fix this frame never got past the pump's parse.
    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        isCommand: true,
        pollFinal: true,
        extended: true,
      }),
    );

    await transport.sentFrames.waitForCount(2, BUDGET_MS);
    expect(traced).toBe(1); // the extended RR reaches the monitor trace and the session
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });

  it("a strict listener still drops an extended supervisory frame with no extended session", async () => {
    // The retry is not a widening of the listener's options: with no live extended
    // session for the peer, a frame the strict mod-8 parse rejected stays
    // rejected, so the listener is deaf to it end to end.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      parseOptions: STRICT_PARSE,
    });

    let traced = 0;
    listener.onFrameTraced(() => traced++);

    await listener.start();
    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        isCommand: true,
        pollFinal: true,
        extended: true,
      }),
    );

    await settle(300);
    expect(traced).toBe(0); // no cached extended session, so the strict rejection is final
    expect(transport.sentFrames.count).toBe(0); // nothing dispatched, so no DM went out

    await listener.dispose();
  });

  it("a strict listener's mod-8 link is unchanged", async () => {
    // The paired mod-8 case: a SABM link on the same strict listener keeps
    // handling its own single-octet supervisory frames, and an extended-shaped one
    // is not smuggled in by the retry (the cached session is not extended).
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      parseOptions: STRICT_PARSE,
    });

    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });
    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    const session = await withTimeout(accepted, BUDGET_MS, "accepted");
    await transport.sentFrames.waitForCount(1, BUDGET_MS);
    expect(session.context.isExtended).toBe(false);

    let traced = 0;
    listener.onFrameTraced(() => traced++);

    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        isCommand: true,
        pollFinal: true,
      }),
    );
    await transport.sentFrames.waitForCount(2, BUDGET_MS);
    await settle(200);

    const before = traced;
    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        isCommand: true,
        pollFinal: true,
        extended: true,
      }),
    );
    await settle(300);
    // The extended-shaped supervisory frame is still dropped on a mod-8 link.
    expect(traced).toBe(before);

    await listener.dispose();
  });

  it("a lenient listener keeps delivering extended supervisory frames", async () => {
    // The pre-existing lenient path (parse at mod-8 capturing the second control
    // octet as info, then re-parse at the session modulo) is untouched.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });

    const session = await connectExtendedInbound(listener, transport);

    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        isCommand: true,
        pollFinal: true,
        extended: true,
      }),
    );

    await transport.sentFrames.waitForCount(2, BUDGET_MS);
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });
});
