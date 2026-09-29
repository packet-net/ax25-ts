/**
 * `ax25Spec114RepeatedConnectUaIgnored` - the TS parity leg of packet.net's
 * `Ax25ListenerRepeatedConnectUaTests` (packet-net/packet.net#842). The UA that
 * answers a dial, delivered twice: LinBPQ with two AXIP `MAP` lines for one
 * address sends every frame once per line. The first UA connects the link;
 * figc4.4 then reads the second, in the connected state, as an unexpected UA
 * and re-establishes, which BPQ answers with two UAs again, for ever. The quirk
 * drops a UA that is byte for byte the one that just connected the link and is
 * the very next frame the peer sends; anything else is left to the figure.
 * `ax25Spec114UnexpectedUaIgnored` (packet-net/packet.net#874, on by default) goes further
 * and drops every UA on an up link, so the shapes the narrow quirk leaves to
 * the figure are dropped by default and reset only with that quirk off.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, iFrame, isCommand, pollFinal, rr, ua } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const Local = Callsign.parse("N0AAA-3");
const Peer = Callsign.parse("N0BBB-9");

// U-frame control octets (P/F masked out).
const SABM_BASE = 0x2f;
const SABME_BASE = 0x6f;

function sent(transport: LoopbackTransport): Ax25Frame[] {
  const frames: Ax25Frame[] = [];
  for (let i = 0; i < transport.sentFrames.count; i++) {
    frames.push(transport.decodedSent(i));
  }
  return frames;
}

function isEstablish(f: Ax25Frame): boolean {
  const base = f.control & 0xef;
  return base === SABM_BASE || base === SABME_BASE;
}

function isRrResponse(f: Ax25Frame): boolean {
  return (f.control & 0x0f) === 0x01 && !isCommand(f);
}

function isPollAnswer(f: Ax25Frame): boolean {
  return isRrResponse(f) && pollFinal(f);
}

const isReset = (s: DataLinkSignal): boolean =>
  s.type === "DL_CONNECT_indication" || s.type === "DL_ERROR_indication";

function watch(session: Ax25ListenerSession): DataLinkSignal[] {
  const signals: DataLinkSignal[] = [];
  session.onDataLinkSignal((s) => signals.push(s));
  return signals;
}

async function dial(
  quirks: Ax25SessionQuirks,
  extended: boolean,
): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  connecting: Promise<Ax25ListenerSession>;
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: Local, quirks });
  await listener.start();
  // `link: dial: v20` against BPQ is a plain SABM with no XID first; the v2.2
  // dial is the same story with SABME.
  const connecting = listener.connect(Peer, extended, false);
  await transport.sentFrames.waitForCount(1, 2000);
  expect(isEstablish(transport.decodedSent(0))).toBe(true);
  return { listener, transport, connecting };
}

describe("ax25Spec114RepeatedConnectUaIgnored", () => {
  it.each([
    [false, 2],
    [false, 3],
    [true, 2],
  ])(
    "a dial answered with the same UA more than once stays connected (extended=%s, copies=%s)",
    async (extended, copies) => {
      const { listener, transport, connecting } = await dial(defaultSessionQuirks, extended);
      const connectingUa = ua({ destination: Local, source: Peer, finalBit: true });
      for (let i = 0; i < copies; i++) {
        transport.injectInbound(connectingUa);
      }
      const session = await withTimeout(connecting, 10_000);

      // An RR poll after the frames under test: inbound frames are handled in
      // order, so once it is answered everything before it has been dispatched.
      transport.injectInbound(rr({ destination: Local, source: Peer, nr: 0, isCommand: true, pollFinal: true, extended }));
      await waitFor(() => sent(transport).some(isRrResponse), 5000, "the poll is answered");

      expect(session.state).toBe("Connected");
      expect(sent(transport).filter(isEstablish)).toHaveLength(1);
      await listener.dispose();
    },
  );

  it("strictly faithful resets on the repeated UA as the figure draws", async () => {
    const { listener, transport, connecting } = await dial(strictlyFaithfulSessionQuirks, false);
    const connectingUa = ua({ destination: Local, source: Peer, finalBit: true });
    transport.injectInbound(connectingUa);
    transport.injectInbound(connectingUa);
    const session = await withTimeout(connecting, 10_000);

    await transport.sentFrames.waitForCount(2, 5000);
    expect(transport.decodedSent(1).control & 0xef).toBe(SABM_BASE);
    expect(session.state).toBe("AwaitingConnection");
    await listener.dispose();
  });

  it("with ax25Spec114UnexpectedUaIgnored off, ax25Spec114RepeatedConnectUaIgnored alone still absorbs a doubled connecting UA", async () => {
    const { listener, transport, connecting } = await dial(
      { ...defaultSessionQuirks, ax25Spec114UnexpectedUaIgnored: false },
      false,
    );
    const connectingUa = ua({ destination: Local, source: Peer, finalBit: true });
    transport.injectInbound(connectingUa);
    transport.injectInbound(connectingUa);
    const session = await withTimeout(connecting, 10_000);

    transport.injectInbound(rr({ destination: Local, source: Peer, nr: 0, isCommand: true, pollFinal: true }));
    await waitFor(() => sent(transport).some(isPollAnswer), 5000, "the poll is answered");

    expect(session.state).toBe("Connected");
    expect(sent(transport).filter(isEstablish)).toHaveLength(1);
    await listener.dispose();
  });

  // Two shapes the narrow quirk leaves to the figure: a UA after other traffic
  // from the peer, and a UA that differs from the connecting one (F=0).
  // ax25Spec114UnexpectedUaIgnored (packet-net/packet.net#874) drops both.
  const lateUaShapes: [string, (transport: LoopbackTransport) => void][] = [
    [
      "a UA after other traffic from the peer",
      (transport) => {
        transport.injectInbound(
          iFrame({ destination: Local, source: Peer, nr: 0, ns: 0, info: new TextEncoder().encode("DAPPSv1>\r") }),
        );
        transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
      },
    ],
    [
      "a UA that differs from the connecting one",
      (transport) => {
        transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: false }));
      },
    ],
  ];

  it.each(lateUaShapes)("%s is dropped under the default quirks", async (_shape, inject) => {
    const { listener, transport, connecting } = await dial(defaultSessionQuirks, false);
    transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
    const session = await withTimeout(connecting, 10_000);
    const signals = watch(session);

    inject(transport);
    transport.injectInbound(rr({ destination: Local, source: Peer, nr: 0, isCommand: true, pollFinal: true }));
    await waitFor(() => sent(transport).some(isPollAnswer), 5000, "the poll is answered");

    expect(session.state).toBe("Connected");
    expect(sent(transport).filter(isEstablish)).toHaveLength(1);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });

  it.each(lateUaShapes)(
    "%s still resets the link with ax25Spec114UnexpectedUaIgnored off",
    async (_shape, inject) => {
      const { listener, transport, connecting } = await dial(
        { ...defaultSessionQuirks, ax25Spec114UnexpectedUaIgnored: false },
        false,
      );
      transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
      const session = await withTimeout(connecting, 10_000);

      inject(transport);
      await waitFor(() => sent(transport).filter(isEstablish).length === 2, 5000, "a SABM follows the late UA");
      expect(session.state).toBe("AwaitingConnection");
      await listener.dispose();
    },
  );
});
