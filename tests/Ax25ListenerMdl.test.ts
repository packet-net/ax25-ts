/**
 * Production-path MDL integration for {@link Ax25Listener} — proves the
 * listener's XID-command routing (dispatchInbound → MDL responder) is live
 * over the real transport, not just the deterministic two-station harness.
 *
 * Covers the un-transcribed figc5.1 *responder* path: a v2.2 peer connects
 * (inbound SABME → our UA, isExtended=true), then sends an XID *command*; the
 * listener routes it to the session's MDL driver, which runs the §6.3.2
 * reverts-to merge against our context and replies with an XID *response*
 * (F=1) carrying the agreed values. (The *initiator* figc4.6 path — connect →
 * UA → auto-send XID command — has no public extended-connect knob on the
 * listener, exactly as in the C# runtime; the harness suite covers it.)
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, pollFinal, xid } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import {
  encodeXid,
  octetsToBits,
  tryParseXid,
  type XidParameters,
} from "../src/xid.js";
import { LoopbackTransport, withTimeout } from "./listener-test-support.js";
import { sabme } from "../src/frame.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

const XID_BASE = 0xaf;
const isXid = (f: Ax25Frame): boolean => (f.control & 0xef) === XID_BASE;

describe("Ax25Listener — MDL XID responder (production path)", () => {
  it("answers an inbound XID command with a merged XID response", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();

    // v2.2 peer connects: inbound SABME → our UA, link goes extended.
    transport.injectInbound(sabme({ destination: LocalCall, source: PeerCall }));
    const session = await withTimeout(accepted, 2000, "accepted");
    await transport.sentFrames.waitForCount(1, 2000); // the UA
    expect(session.context.isExtended).toBe(true);

    // The peer sends an XID command offering only implicit-reject + mod-8 with
    // a small window — so the §6.3.2 merge must drop SREJ and mod-128 on our
    // side and pull k down to the peer's advertised value.
    const peerOffer: XidParameters = {
      classesOfProcedures: { halfDuplex: true },
      hdlcOptionalFunctions: {
        reject: "implicit",
        modulo128: false,
        srejMultiframe: false,
        segmenterReassembler: false,
      },
      iFieldLengthRxBits: octetsToBits(128),
      windowSizeRx: 4,
      ackTimerMillis: 5000,
      retries: 12,
    };
    transport.injectInbound(
      xid({
        destination: LocalCall,
        source: PeerCall,
        info: encodeXid(peerOffer),
        isCommand: true,
        pollFinal: true,
      }),
    );

    // The listener replies with an XID response (the figc5.1 responder path).
    await transport.sentFrames.waitForCount(2, 2000);
    const reply = transport.decodedSent(1);
    expect(isXid(reply)).toBe(true);
    expect(reply.destination.callsign.equals(PeerCall)).toBe(true);
    // F=1 — the initiator's figc5.2 F_eq_1 diamond requires it.
    expect(pollFinal(reply)).toBe(true);

    // The merge landed on OUR context: reject→implicit, modulo→8 (both lesser),
    // k→4 (min of 4 and our default 4). T1→6000 (greater: our default T1V of
    // 6000ms beats the peer's 5000) and N2→12 (greater: the peer's 12 beats our
    // default 10) — both demonstrating the "reverts to greater" rule using our
    // own context-derived offer as one side.
    expect(session.context.srejEnabled).toBe(false);
    expect(session.context.implicitReject).toBe(true);
    expect(session.context.isExtended).toBe(false);
    expect(session.context.k).toBe(4);
    expect(session.context.t1vMs).toBe(6000);
    expect(session.context.n2).toBe(12);

    // The response echoes the agreed values, so the initiator's own merge lands
    // identically.
    const parsed = tryParseXid(reply.info);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.parameters.hdlcOptionalFunctions?.reject).toBe("implicit");
      expect(parsed.parameters.hdlcOptionalFunctions?.modulo128).toBe(false);
      expect(parsed.parameters.windowSizeRx).toBe(4);
    }

    await listener.dispose();
  });
});
