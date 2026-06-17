/**
 * Outbound CONNECT version-preference unit tests for {@link Ax25Listener} — the
 * TS parity leg of packet.net's `Ax25ListenerPreferV22ConnectTests`. A default
 * dial prefers AX.25 v2.2 (SABME / mod-128) so the link negotiates SREJ + window
 * against capable peers and degrades cleanly to v2.0/SABM for peers that can't
 * (FRMR — LinBPQ; DM — XRouter, exercised live in the interop suite). The opt-out
 * ({@link Ax25ListenerOptions.preferExtendedConnect} = `false`, or the per-call
 * `extended` override) initiates a plain v2.0 (SABM) connect.
 *
 * These tests assert the *first frame on the wire*: a v2.2-preferred dial emits a
 * SABME, a v2.0 dial emits a SABM, and a mod-8 dial with the default-on
 * pre-SABM SREJ negotiation leads with an XID command. The full SABME → UA → XID
 * round-trip and the FRMR/DM fallbacks are proven against real peers in the
 * packet.net Interop suite. The inbound answerer is deliberately untouched — it
 * adopts the peer's version from the SABM/SABME it receives (figc4.1).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { Ax25Listener } from "../src/listener.js";
import { LoopbackTransport } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

// U-frame control octets (P/F masked out).
const SABM_BASE = 0x2f;
const SABME_BASE = 0x6f;
const XID_BASE = 0xaf;

/**
 * Fire the dial fire-and-forget: the connect awaits DL-CONNECT-confirm (which
 * never arrives — no peer answers the loopback), but the lead frame hits the
 * wire synchronously on dispatch. Swallow the eventual timeout rejection so it
 * doesn't surface as an unhandled rejection.
 */
function dialAndIgnore(listener: Ax25Listener, ...args: [Callsign, boolean?]): void {
  void listener.connect(...args).catch(() => {});
}

describe("Ax25Listener — outbound CONNECT version preference", () => {
  it("default dial prefers v2.2 and emits SABME", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    dialAndIgnore(listener, PeerCall); // preferExtendedConnect defaults to true

    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(SABME_BASE);

    await listener.dispose();
  });

  it("listener opt-out emits SABM", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      preferExtendedConnect: false, // opt out → plain v2.0 connect
      // Isolate the version choice from the pre-SABM SREJ XID exchange: with the
      // default-on preConnectXidNegotiatesSrej a mod-8 dial's FIRST frame is the
      // XID command, not the SABM (asserted separately below).
      preConnectXidNegotiatesSrej: false,
    });
    await listener.start();

    dialAndIgnore(listener, PeerCall);

    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(SABM_BASE);

    await listener.dispose();
  });

  it("per-call extended=false forces SABM even when the listener prefers v2.2", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      // Listener default prefers v2.2 …
      // Isolate the version override from the pre-SABM SREJ XID exchange (see
      // "listener opt-out emits SABM"): a mod-8 dial's first frame is else XID.
      preConnectXidNegotiatesSrej: false,
    });
    await listener.start();

    dialAndIgnore(listener, PeerCall, false); // … but this dial opts out per-call

    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(SABM_BASE);

    await listener.dispose();
  });

  it("per-call extended=true forces SABME even when the listener opts out", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      preferExtendedConnect: false, // listener default is v2.0 …
    });
    await listener.start();

    dialAndIgnore(listener, PeerCall, true); // … but this dial prefers v2.2 per-call

    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(SABME_BASE);

    await listener.dispose();
  });

  it("mod-8 dial with preConnectXidNegotiatesSrej leads with an XID command", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      preferExtendedConnect: false, // mod-8 dial …
      preConnectXidNegotiatesSrej: true, // … with the default-on pre-SABM SREJ negotiation
    });
    await listener.start();

    dialAndIgnore(listener, PeerCall);

    // The FIRST frame on a mod-8 dial is now the XID command (the LinBPQ SREJ
    // accommodation), not the SABM — the SABM follows once the XID exchange
    // settles or times out. No peer answers here, so we only assert the lead XID.
    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.decodedSent(0).control & 0xef).toBe(XID_BASE);

    await listener.dispose();
  });
});
