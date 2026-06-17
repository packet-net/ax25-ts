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
import { sabm, sabme } from "../src/frame.js";

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

  it("answers a pre-session XID command, then the SABM adopts the negotiated SREJ", async () => {
    // The PDN↔PDN NET/ROM mod-8 interlink case: the initiator does pre-SABM XID
    // negotiation with NO active session yet. §4.3.3.7 makes answering an XID
    // command unconditional (no active link required), so the listener must build
    // + cache a session, answer the XID command (figc5.1 responder), and let the
    // subsequent SABM adopt the XID-negotiated SREJ — the figc4.1 t14 "Set
    // Version 2.0" clears only IsExtended, never SrejEnabled. (Previously this XID
    // fell through to a transient → DM, and the initiator stalled.)
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();

    // The peer's pre-session XID command DOES offer SREJ (a v2.2-capable peer
    // doing mod-8 with selective reject), so the §6.3.2 merge keeps SREJ on our
    // side — the whole point of the negotiation.
    const peerOffer: XidParameters = {
      classesOfProcedures: { halfDuplex: true },
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: false,
        srejMultiframe: true,
        segmenterReassembler: false,
      },
      iFieldLengthRxBits: octetsToBits(256),
      windowSizeRx: 7,
      ackTimerMillis: 5000,
      retries: 10,
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

    // The listener answers the pre-session XID command with an XID response
    // (F=1) — no SessionAccepted yet (no DL-CONNECT until the SABM arrives).
    await transport.sentFrames.waitForCount(1, 2000);
    const xidReply = transport.decodedSent(0);
    expect(isXid(xidReply)).toBe(true);
    expect(xidReply.destination.callsign.equals(PeerCall)).toBe(true);
    expect(pollFinal(xidReply)).toBe(true);
    // The response echoes the agreed values — SREJ survived the merge (both
    // sides offered it).
    const parsedReply = tryParseXid(xidReply.info);
    expect(parsedReply.ok).toBe(true);
    if (parsedReply.ok) {
      expect(parsedReply.parameters.hdlcOptionalFunctions?.reject).toBe(
        "selective",
      );
      expect(parsedReply.parameters.hdlcOptionalFunctions?.srejMultiframe).toBe(
        true,
      );
      expect(parsedReply.parameters.hdlcOptionalFunctions?.modulo128).toBe(
        false,
      );
    }

    // Now the peer sends the SABM. The cached (XID-negotiated) session answers
    // it — the link comes up Connected at mod-8 with SREJ intact, and only now
    // does SessionAccepted fire.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    const session = await withTimeout(accepted, 2000, "accepted");
    await transport.sentFrames.waitForCount(2, 2000); // the UA
    expect(session.state).toBe("Connected");
    // The SABM adopted the XID-negotiated SREJ (Set Version 2.0 cleared only the
    // extended bit), and stayed mod-8.
    expect(session.context.srejEnabled).toBe(true);
    expect(session.context.implicitReject).toBe(false);
    expect(session.context.isExtended).toBe(false);

    await listener.dispose();
  });
});
