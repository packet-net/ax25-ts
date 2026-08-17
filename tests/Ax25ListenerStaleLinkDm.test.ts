/**
 * figc4.1 catch-all coverage for a peer that still believes a link we have
 * already torn down is up: the "stale link" case.
 *
 * The listener caches sessions across disconnect (they keep their SRT / T1V
 * history for the next time that peer calls), so the ordinary state of affairs
 * after a QSO ends is a CACHED session sitting in Disconnected. A peer whose view
 * of the link survived ours (its DISC lost, our UA lost, or it simply never heard
 * the teardown) then polls us with an RR command carrying P=1. figc4.1 t05 (`all
 * other commands`) answers that with a DM, which clears the peer's link on the
 * spot; staying silent instead makes the peer burn its whole retry budget
 * (LinBPQ: RETRIES x FRACK = 30 s of pointless polling on a shared channel)
 * before it gives up, and leaves it holding a link-table entry that changes how
 * it treats our next connection attempt.
 *
 * Routing a cached-Disconnected session used to post the classifier's specific
 * event (`RR_received`) straight into the session, where Disconnected has no
 * transition for it, so the frame was silently swallowed, while the very same
 * frame from a peer we had evicted from the cache got the correct DM. These tests
 * pin the two halves of the fixed rule: a command gets the t05 DM, a response
 * gets t06's discard (answering a response with a DM, itself a response, would
 * have two disconnected stations trading DMs forever).
 *
 * TS port of packet.net's Ax25ListenerStaleLinkDmTests.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { disc, dm, isResponse, pollFinal, rr, sabm } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");
const BUDGET_MS = 2000;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Establish a session from an inbound SABM, then tear it down with a DISC, so
 *  the listener is left holding a CACHED session in Disconnected. */
async function cachedDisconnectedSession(
  transport: LoopbackTransport,
  listener: Ax25Listener,
): Promise<Ax25ListenerSession> {
  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted((s) => resolve(s));
  });
  await listener.start();

  transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
  const session = await withTimeout(accepted, BUDGET_MS, "accepted");
  await transport.sentFrames.waitForCount(1, BUDGET_MS);

  transport.injectInbound(disc({ destination: LocalCall, source: PeerCall }));
  await transport.sentFrames.waitForCount(2, BUDGET_MS);
  await waitFor(
    () => session.state === "Disconnected",
    BUDGET_MS,
    "the DISC must return us to Disconnected",
  );
  return session;
}

describe("stale-link DM (m0lte/packet.net#735)", () => {
  it("answers DM when a peer polls a cached Disconnected session", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await cachedDisconnectedSession(transport, listener);

    // The peer never saw the teardown and polls the link it still believes in.
    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 3,
        isCommand: true,
        pollFinal: true,
      }),
    );

    await transport.sentFrames.waitForCount(3, BUDGET_MS);
    const reply = transport.decodedSent(2);
    // figc4.1 t05 answers a command received in Disconnected with a DM, whether
    // or not the session is still in the listener's cache.
    expect(reply.control & 0xef).toBe(0x0f);
    expect(pollFinal(reply)).toBe(true); // t05 assigns F := P, and the poll carried P=1
    expect(isResponse(reply)).toBe(true); // a DM is always a response
    expect(reply.destination.callsign.equals(PeerCall)).toBe(true);
    expect(reply.source.callsign.equals(LocalCall)).toBe(true);

    await listener.dispose();
  });

  it("stays silent for a response to a cached Disconnected session", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await cachedDisconnectedSession(transport, listener);

    transport.injectInbound(
      rr({
        destination: LocalCall,
        source: PeerCall,
        nr: 3,
        isCommand: false,
        pollFinal: true,
      }),
    );

    await settle(200);
    // A response frame in Disconnected is t06 (discard): answering it with a DM
    // would have two disconnected stations trade DMs forever.
    expect(transport.sentFrames.count).toBe(2);

    await listener.dispose();
  });

  it("stays silent for a DM from an unknown peer", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    transport.injectInbound(
      dm({ destination: LocalCall, source: PeerCall, finalBit: true }),
    );

    await settle(200);
    expect(transport.sentFrames.count).toBe(0); // a DM is a response: t06 discards it

    await listener.dispose();
  });
});
