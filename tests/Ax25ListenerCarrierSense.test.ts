/**
 * The native carrier-sense CSMA gate (OQ-012) wired into a live
 * {@link Ax25Listener} — TS port of the C#
 * `tests/Packet.Ax25.Tests/Session/Ax25ListenerCarrierSenseTests.cs`.
 *
 * An injected {@link CarrierSense} holds the listener's keyups while the channel
 * is busy and releases them when it clears — without altering the data-link SDL
 * (the SABM still drives figc4.1 t14 → UA + Connected; only the *physical* UA is
 * deferred). With no source injected the listener is byte-for-byte its prior self,
 * which every other `Ax25Listener*` test already covers; the baseline here pins
 * that explicitly.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { sabm } from "../src/frame.js";
import { type CarrierSense } from "../src/carrier-sense.js";
import {
  Ax25Listener,
  type Ax25ListenerSession,
} from "../src/listener.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M9YYY");
const PeerCall = Callsign.parse("GB7BPQ-1");

/** A scripted carrier-sense source the test flips between busy and clear. */
class FakeCarrierSense implements CarrierSense {
  busy: boolean | null;
  constructor(busy: boolean | null) {
    this.busy = busy;
  }
  channelBusy(): boolean | null {
    return this.busy;
  }
}

/** UA U-frame test (§4.3.3): control 0x63 with the P/F bit masked off. */
function isUa(control: number): boolean {
  return (control & 0xef) === 0x63;
}

describe("Ax25Listener — native carrier-sense CSMA", () => {
  it("defers the reply while the channel is busy and sends it when it clears", async () => {
    const transport = new LoopbackTransport();
    const carrier = new FakeCarrierSense(true); // channel busy at SABM time
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      carrierSense: carrier,
    });

    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => resolve(s));
    });
    await listener.start();

    // Peer opens the link. The SDL emits the UA (figc4.1 t14) and reaches
    // Connected, but the keyup is held by the medium-access gate (busy channel).
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    const session = await withTimeout(accepted, 2000, "sessionAccepted");

    // The SDL transition ran — only the keyup is deferred.
    expect(session.state).toBe("Connected");
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.sentFrames.count).toBe(0); // busy channel holds the UA off the air

    // Channel clears; the gate re-samples (default 100 ms slot) and keys up.
    carrier.busy = false;
    await transport.sentFrames.waitForCount(1, 2000);
    expect(isUa(transport.decodedSent(0).control)).toBe(true);

    await listener.dispose();
  });

  it("with no carrier-sense source the reply is sent immediately", async () => {
    const transport = new LoopbackTransport();
    // No carrierSense — the always-clear degenerate gate. Behaviour must be unchanged.
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));

    // No source: the UA keys up immediately.
    await transport.sentFrames.waitForCount(1, 2000);
    expect(isUa(transport.decodedSent(0).control)).toBe(true);

    await listener.dispose();
  });

  it("a clear channel does not defer", async () => {
    const transport = new LoopbackTransport();
    const carrier = new FakeCarrierSense(false); // source present but clear
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      carrierSense: carrier,
    });
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));

    // A definite "clear" keys up immediately — only a definite "busy" defers.
    await transport.sentFrames.waitForCount(1, 2000);
    expect(isUa(transport.decodedSent(0).control)).toBe(true);

    await listener.dispose();
  });

  it("an unknown (null) carrier state fails open — keys up immediately", async () => {
    const transport = new LoopbackTransport();
    const carrier = new FakeCarrierSense(null); // cannot sense / no report yet
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      carrierSense: carrier,
    });
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));

    await transport.sentFrames.waitForCount(1, 2000);
    expect(isUa(transport.decodedSent(0).control)).toBe(true);

    await listener.dispose();
    // (waitFor imported for parity with sibling suites; unused here.)
    void waitFor;
  });
});
