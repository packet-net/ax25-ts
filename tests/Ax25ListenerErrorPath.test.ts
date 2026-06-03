/**
 * Receive-path error-classification coverage for {@link Ax25Listener} — the
 * end-to-end half of finding #3 from the test campaign. The C# receive path
 * (`Ax25FrameClassifier`) turns a spec-violating inbound frame into the matching
 * SDL error event so the figc4.x error-input transition fires (DL-ERROR +
 * re-establish) instead of the malformed frame being silently processed. These
 * tests assert the TS receive path now does the same, via {@link classifyFrame}
 * wired into {@link Ax25Listener.dispatchInbound}.
 *
 * Behaviour mirrors the C# reference:
 *   - an info-bearing no-info U frame (DM) or S frame (RR) delivered to a
 *     Connected session → DL-ERROR (M) + Establish_Data_Link (SABM out) →
 *     AwaitingConnection (figc4.1/4.7 t10 `info_not_permitted_in_frame`);
 *   - an unknown U-frame control byte → DL-ERROR (L) + re-establish
 *     (t09 `control_field_error`);
 *   - a well-formed frame does NOT trip the error path.
 *
 * The malformed frames are injected as raw bytes ({@link LoopbackTransport.injectInboundBytes})
 * — the listener decodes them with the default (lenient) parse, so the trailing
 * info / unknown control survives to the classifier, exactly as on a real wire.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  dm,
  encodeFrame,
  iFrame,
  rr,
  sabm,
} from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

/** Stand up a listener, drive an inbound SABM, and return the accepted,
 * Connected session plus its DL-signal log. */
async function establishConnected(): Promise<{
  transport: LoopbackTransport;
  listener: Ax25Listener;
  session: Ax25ListenerSession;
  signals: DataLinkSignal[];
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: LocalCall });

  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted((s) => {
      if (s.context.remote.equals(PeerCall)) resolve(s);
    });
  });

  await listener.start();
  transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
  const session = await withTimeout(accepted, 2000, "sessionAccepted");
  await waitFor(() => session.state === "Connected", 2000, "reach Connected");

  const signals: DataLinkSignal[] = [];
  session.onDataLinkSignal((s) => signals.push(s));
  return { transport, listener, session, signals };
}

/** Wire bytes for `frame` with `extra` bytes appended after the control field —
 * a spec-violating info field on a frame type that carries none. */
function withTrailing(frame: Ax25Frame, ...extra: number[]): Uint8Array {
  const base = encodeFrame(frame);
  const out = new Uint8Array(base.length + extra.length);
  out.set(base, 0);
  out.set(Uint8Array.from(extra), base.length);
  return out;
}

describe("Ax25Listener — receive-path error classification (finding #3)", () => {
  it("info-bearing DM on an established session → DL-ERROR (M) + re-establish (SABM out)", async () => {
    const { transport, listener, session, signals } = await establishConnected();
    const sentBefore = transport.sentFrames.count;

    // A DM carrying a trailing info byte is malformed (§3.5). The classifier
    // maps it to info_not_permitted_in_frame; Connected t10 raises DL-ERROR (M)
    // and re-establishes.
    transport.injectInboundBytes(
      withTrailing(dm({ destination: LocalCall, source: PeerCall }), 0x99),
    );

    await waitFor(
      () => signals.some((s) => s.type === "DL_ERROR_indication" && s.code === "M"),
      2000,
      "DL-ERROR (M)",
    );

    // Re-establish: left Connected, and a SABM (mod-8) went out (P=1).
    await waitFor(() => session.state !== "Connected", 2000, "leave Connected");
    expect(session.state).toBe("AwaitingConnection");
    await transport.sentFrames.waitForCount(sentBefore + 1, 2000);
    const reSabm = transport.decodedSent(transport.sentFrames.count - 1);
    expect(classify(reSabm)).toBe("SABM");
    expect(reSabm.destination.callsign.equals(PeerCall)).toBe(true);

    await listener.dispose();
  });

  it("info-bearing S frame (RR) on an established session → DL-ERROR (M) + re-establish", async () => {
    const { transport, listener, session, signals } = await establishConnected();

    transport.injectInboundBytes(
      withTrailing(rr({ destination: LocalCall, source: PeerCall, nr: 0, isCommand: false }), 0x01, 0x02),
    );

    await waitFor(
      () => signals.some((s) => s.type === "DL_ERROR_indication" && s.code === "M"),
      2000,
      "DL-ERROR (M)",
    );
    await waitFor(() => session.state !== "Connected", 2000, "leave Connected");
    expect(session.state).toBe("AwaitingConnection");

    await listener.dispose();
  });

  it("unknown U-frame control byte on an established session → DL-ERROR (L) + re-establish", async () => {
    const { transport, listener, session, signals } = await establishConnected();
    const sentBefore = transport.sentFrames.count;

    // Build a valid SABM, then overwrite its control octet with an unknown
    // U-frame pattern (bits 1-0 = 11, but no known subtype).
    const probe = encodeFrame(sabm({ destination: LocalCall, source: PeerCall }));
    probe[14] = 0x17; // U-shape, unknown subtype
    transport.injectInboundBytes(probe);

    await waitFor(
      () => signals.some((s) => s.type === "DL_ERROR_indication" && s.code === "L"),
      2000,
      "DL-ERROR (L)",
    );
    await waitFor(() => session.state !== "Connected", 2000, "leave Connected");
    expect(session.state).toBe("AwaitingConnection");
    await transport.sentFrames.waitForCount(sentBefore + 1, 2000);
    expect(classify(transport.decodedSent(transport.sentFrames.count - 1))).toBe("SABM");

    await listener.dispose();
  });

  it("a well-formed frame does NOT trip the error path (no DL-ERROR, stays Connected)", async () => {
    const { transport, listener, session, signals } = await establishConnected();

    // A clean I-frame in-sequence: delivered as data, never an error.
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCall,
        nr: 0,
        ns: 0,
        info: new TextEncoder().encode("OK"),
        pollBit: false,
      }),
    );
    await waitFor(() => signals.some((s) => s.type === "DL_DATA_indication"), 2000, "data delivered");

    // Settle, then assert no error fired and the link is still up.
    await new Promise((r) => setTimeout(r, 100));
    expect(signals.some((s) => s.type === "DL_ERROR_indication")).toBe(false);
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });
});
