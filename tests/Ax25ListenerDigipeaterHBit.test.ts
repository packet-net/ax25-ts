/**
 * The has-been-repeated (H) bit on the digipeater slots (sections 3.12.4 /
 * 4.2.2). A frame whose last repeater slot still has H=0 is in transit to that
 * digipeater; hearing it directly does not make it ours to answer. The listener
 * used to filter on destination alone, so it answered the unrepeated copy and
 * then processed the digi's repeat as a second frame: one SABM heard both ways
 * drew two UAs (m0lte/packet.net#696). It is now monitor-only until every
 * repeater slot is marked repeated.
 *
 * TS port of packet.net's Ax25ListenerDigipeaterHBitTests.
 */
import { describe, expect, it } from "vitest";
import { ADDRESS_ENCODED_LENGTH } from "../src/address.js";
import { Callsign } from "../src/callsign.js";
import { classify, encodeFrame, sabm } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");
const DigiCall = Callsign.parse("MB7UR");

// The digipeater's SSID octet: 2 address slots (destination, source) of 7 octets
// each, then the repeater slot, whose 7th octet carries the H bit.
const DIGI_SSID_OCTET = 2 * ADDRESS_ENCODED_LENGTH + 6;

function sabmViaDigi(repeated: boolean): Uint8Array {
  const bytes = encodeFrame(
    sabm({ destination: LocalCall, source: PeerCall, digipeaters: [DigiCall] }),
  );
  expect(bytes[DIGI_SSID_OCTET]! & 0x80).toBe(0); // the factory builds an unrepeated path
  if (repeated) bytes[DIGI_SSID_OCTET]! |= 0x80;
  return bytes;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("digipeater H-bit (m0lte/packet.net#696)", () => {
  it("an unrepeated frame is monitor-only", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });

    let accepted = 0;
    let traced = 0;
    listener.onSessionAccepted(() => accepted++);
    listener.onFrameTraced(() => traced++);

    await listener.start();
    transport.injectInboundBytes(sabmViaDigi(false));
    await settle(200);

    // The frame is still on its way to MB7UR: not ours to answer yet.
    expect(accepted).toBe(0);
    // Answering would put a UA on the air for an undelivered SABM.
    expect(transport.sentFrames.count).toBe(0);
    // A monitor consumer still sees the frame.
    expect(traced).toBe(1);

    await listener.dispose();
  });

  it("the repeated copy is answered exactly once", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();

    // Both copies of one SABM, as a station within earshot of both the sender and
    // its digipeater hears them.
    transport.injectInboundBytes(sabmViaDigi(false));
    transport.injectInboundBytes(sabmViaDigi(true));

    const session = await withTimeout(accepted, 2000, "accepted");
    await transport.sentFrames.waitForCount(1, 2000);
    await settle(200);

    expect(session.state).toBe("Connected");
    expect(transport.sentFrames.count).toBe(1); // exactly one UA for one SABM
    expect(classify(transport.decodedSent(0))).toBe("UA");

    await listener.dispose();
  });

  it("a frame with no digipeaters is unaffected", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));

    const session = await withTimeout(accepted, 2000, "accepted");
    await transport.sentFrames.waitForCount(1, 2000);
    expect(session.state).toBe("Connected");

    await listener.dispose();
  });
});
