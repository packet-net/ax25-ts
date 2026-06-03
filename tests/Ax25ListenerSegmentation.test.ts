/**
 * Listener-level coverage of the §6.6 segmentation seam wired into
 * {@link Ax25Listener} — the TS port of packet.net's
 * `Ax25ListenerSegmentationTests`. {@link Ax25Listener.sendData} routes an
 * over-N1 payload through the per-session {@link SegmentationLayer} on send (so
 * it leaves the modem as several PID-0x08 I-frames), rejects an over-N1 payload
 * cleanly when the segmenter is not negotiated, and the receive-side
 * reassembler is wired into the upward-signal fan-out.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  PID_NET_ROM,
  PID_NO_LAYER_3,
  PID_SEGMENTED,
  classify,
  iFrame,
  sabm,
} from "../src/frame.js";
import {
  Ax25Listener,
  type Ax25ListenerSession,
} from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import { SEGMENT_FIRST_BIT } from "../src/sdl/segmenter.js";
import { SegmentationLayer } from "../src/sdl/segmentation-layer.js";
import type { Ax25SessionContext } from "../src/sdl/session-context.js";
import { strictlyFaithfulSessionQuirks } from "../src/sdl/session-quirks.js";
import {
  LoopbackTransport,
  waitFor,
  withTimeout,
} from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

/** Accept an inbound SABM and return the Connected session, with the session's
 * context customised via `configure` before any events flow (so
 * segmenterReassemblerEnabled / n1 are set in time). */
async function acceptedSession(
  configure: (ctx: Ax25SessionContext) => void,
): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  session: Ax25ListenerSession;
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, {
    myCall: LocalCall,
    configureSession: (s) => configure(s.context),
  });
  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted((s) => resolve(s));
  });

  await listener.start();
  transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
  const session = await withTimeout(accepted, 2000, "sessionAccepted");
  await transport.sentFrames.waitForCount(1, 2000); // the UA
  expect(session.state).toBe("Connected");
  return { listener, transport, session };
}

/**
 * As {@link acceptedSession}, but also wires a DL-DATA-indication observer onto
 * the session's signal stream (in `configureSession`, before any events flow)
 * so a test can see exactly what the receive-side segmentation seam delivers
 * upward. Mirrors C#'s `AcceptedSessionObservingData` (packet.net#284).
 */
async function acceptedSessionObservingData(
  configure: (ctx: Ax25SessionContext) => void,
): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  session: Ax25ListenerSession;
  delivered: DataLinkSignal[];
}> {
  const delivered: DataLinkSignal[] = [];
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, {
    myCall: LocalCall,
    configureSession: (s) => {
      configure(s.context);
      s.onDataLinkSignal((sig) => {
        if (sig.type === "DL_DATA_indication") delivered.push(sig);
      });
    },
  });
  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted((s) => resolve(s));
  });

  await listener.start();
  transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
  const session = await withTimeout(accepted, 2000, "sessionAccepted");
  await transport.sentFrames.waitForCount(1, 2000); // the UA
  expect(session.state).toBe("Connected");
  return { listener, transport, session, delivered };
}

describe("Ax25Listener — segmentation seam", () => {
  it("sendData segments an over-N1 payload into PID-0x08 I-frames on the wire", async () => {
    const { listener, transport, session } = await acceptedSession((ctx) => {
      ctx.n1 = 64;
      ctx.k = 16;
      ctx.segmenterReassemblerEnabled = true;
    });

    const ua = transport.sentFrames.count; // frames already sent (the UA)
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff); // 5 segments at N1=64

    // A non-default L3 PID so we can see it carried as the first-segment inner PID.
    listener.sendData(session, payload, PID_NET_ROM);

    // Five I-frames, each carrying PID 0x08, should hit the modem.
    await transport.sentFrames.waitForCount(ua + 5, 2000);
    const frames: Ax25Frame[] = [];
    for (let i = ua; i < ua + 5; i++) frames.push(transport.decodedSent(i));

    expect(frames.length).toBe(5);
    expect(frames.every((f) => classify(f) === "I")).toBe(true); // each segment is a normal I-frame
    expect(frames.every((f) => f.pid === PID_SEGMENTED)).toBe(true); // PID 0x08 on every segment

    // Default quirk (segmentFirstCarriesL3Pid on): the FIRST segment's info
    // field is [F/X = First|count][inner-PID = original L3 PID][data…]. So the
    // first segment's second info octet is the original L3 PID.
    const firstInfo = frames[0].info;
    expect(firstInfo[0] & SEGMENT_FIRST_BIT).not.toBe(0); // segment 0 must be the First segment
    expect(firstInfo[1]).toBe(PID_NET_ROM); // inner-PID octet = original L3 PID (Dire Wolf's default format)

    await listener.dispose();
  });

  it("sendData under strictlyFaithful emits the figure-literal format without an inner PID", async () => {
    const { listener, transport, session } = await acceptedSession((ctx) => {
      ctx.n1 = 64;
      ctx.k = 16;
      ctx.segmenterReassemblerEnabled = true;
      ctx.quirks = strictlyFaithfulSessionQuirks;
    });

    const ua = transport.sentFrames.count;
    // payload[0] = 0, distinct from PID_NET_ROM (0xCF), so we can tell the first
    // segment's second octet is payload, not an inner PID.
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);

    listener.sendData(session, payload, PID_NET_ROM);

    await transport.sentFrames.waitForCount(ua + 5, 2000);
    const frames: Ax25Frame[] = [];
    for (let i = ua; i < ua + 5; i++) frames.push(transport.decodedSent(i));

    // Figure-literal: 300 bytes / (N1-1=63) = 5 segments (no inner-PID octet
    // stealing a slot).
    expect(frames.length).toBe(5);
    expect(frames.every((f) => f.pid === PID_SEGMENTED)).toBe(true);

    const firstInfo = frames[0].info;
    expect(firstInfo[0] & SEGMENT_FIRST_BIT).not.toBe(0); // segment 0 must be the First segment
    expect(firstInfo[1]).toBe(0); // figure-literal: byte after F/X is the first PAYLOAD byte, not an inner PID

    await listener.dispose();
  });

  it("sendData passes a within-N1 payload as a single I-frame", async () => {
    const { listener, transport, session } = await acceptedSession((ctx) => {
      ctx.n1 = 256;
      ctx.segmenterReassemblerEnabled = true;
    });

    const ua = transport.sentFrames.count;
    listener.sendData(session, new Uint8Array(100), PID_NO_LAYER_3);

    await transport.sentFrames.waitForCount(ua + 1, 2000);
    const f = transport.decodedSent(ua);
    expect(f.pid).toBe(PID_NO_LAYER_3); // within-N1 passes through with its L3 PID, unsegmented

    await listener.dispose();
  });

  it("sendData rejects an over-N1 payload when the segmenter is not negotiated", async () => {
    const { listener, session } = await acceptedSession((ctx) => {
      ctx.n1 = 256;
      ctx.segmenterReassemblerEnabled = false; // v2.0 / not negotiated
    });

    expect(() => listener.sendData(session, new Uint8Array(300))).toThrow(
      /segmenter\/reassembler has not been negotiated/,
    );

    await listener.dispose();
  });

  it("sendData rejects a session the listener does not own", async () => {
    const { listener } = await acceptedSession(() => {});

    // A session this listener never built. The simplest "alien" is a separate
    // listener's session for a different peer.
    const otherTransport = new LoopbackTransport();
    const otherListener = new Ax25Listener(otherTransport, {
      myCall: LocalCall,
    });
    const accepted = new Promise<Ax25ListenerSession>((resolve) =>
      otherListener.onSessionAccepted((s) => resolve(s)),
    );
    await otherListener.start();
    otherTransport.injectInbound(
      sabm({ destination: LocalCall, source: Callsign.parse("M5ABC-3") }),
    );
    const alien = await withTimeout(accepted, 2000, "alien session");
    await waitFor(() => alien.state === "Connected", 2000);

    expect(() => listener.sendData(alien, new Uint8Array(10))).toThrow(
      /not owned by this listener/,
    );

    await listener.dispose();
    await otherListener.dispose();
  });

  it("drops a malformed segment off the wire, then reassembles a following valid series", async () => {
    // The receive-path hardening (TS parity with packet.net#284): a malformed
    // PID-0x08 segment arriving off the wire through the real Ax25Listener pump
    // (emitUpward) is dropped cleanly at the SegmentationLayer seam — no DL-DATA
    // indication surfaces, the pump survives, and (the reset half) a valid
    // segmented series delivered immediately afterwards still reassembles intact.
    // This proves the fix does not lean on the listener's inbound catch-all.
    const { listener, transport, delivered } = await acceptedSessionObservingData(
      (ctx) => {
        ctx.n1 = 16;
        ctx.segmenterReassemblerEnabled = true;
        ctx.quirks = strictlyFaithfulSessionQuirks; // figure-literal: no inner-PID octet
      },
    );

    // A malformed segment off the wire: a non-First (First bit clear) segment
    // with no in-progress series, carried as a normal I-frame, PID 0x08, N(S)=0.
    // The I-frame is sequence-valid (so V(R) advances), but its info field is a
    // protocol-violating segment — it must be dropped at the seam, delivering
    // nothing upward, without throwing through the pump.
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        ns: 0,
        info: Uint8Array.from([0x05, 0xaa, 0xbb]),
        pid: PID_SEGMENTED,
      }),
    );

    // A valid single-segment series immediately afterwards (N(S)=1): First bit
    // set, remaining 0, one data byte 0x42. If the malformed segment had poisoned
    // the reassembler — or thrown through the pump and wedged it — this would not
    // reassemble.
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        ns: 1,
        info: Uint8Array.from([SEGMENT_FIRST_BIT | 0, 0x42]),
        pid: PID_SEGMENTED,
      }),
    );

    await waitFor(
      () => delivered.length > 0,
      2000,
      "the valid series after the dropped malformed segment must reassemble and surface",
    );

    expect(delivered.length).toBe(1); // only the valid series — the malformed segment surfaced nothing
    const ind = delivered[0];
    expect(ind.type).toBe("DL_DATA_indication");
    expect(Array.from((ind as { data: Uint8Array }).data)).toEqual([0x42]); // no leakage from the malformed one
    expect((ind as { pid: number }).pid).toBe(SegmentationLayer.figureLiteralReassembledPid);

    await listener.dispose();
  });
});
