/**
 * `repeatedConnectSabmReacknowledged` - the TS parity leg of packet.net's
 * `Ax25ListenerRepeatedConnectSabmTests` (packet-net/packet.net#856). A peer
 * that sent SABM(E) and lost our UA sends it again on T1 (§6.3.1). If we are
 * connected by then, and may have sent data, figc4.4 reads the copy as the §6.5
 * reset and, with frames outstanding, discards the I-frame queue. Two stations
 * that dial each other at once and lose one UA of the crossing hit this, and
 * so does a banner sent on any call we answer. The quirk answers a
 * byte-identical copy of the SABM(E) we answered with UA again, until the peer
 * sends anything else; anything else still runs the figure.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, rr, sabme, ua } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const Local = Callsign.parse("N0AAA-3");
const Peer = Callsign.parse("N0BBB-3");

// U-frame control octets (P/F masked out).
const SABM_BASE = 0x2f;
const SABME_BASE = 0x6f;
const UA_BASE = 0x63;

function sent(transport: LoopbackTransport): Ax25Frame[] {
  const frames: Ax25Frame[] = [];
  for (let i = 0; i < transport.sentFrames.count; i++) {
    frames.push(transport.decodedSent(i));
  }
  return frames;
}

const base = (f: Ax25Frame): number => f.control & 0xef;
const isEstablish = (f: Ax25Frame): boolean => base(f) === SABM_BASE || base(f) === SABME_BASE;
const isUa = (f: Ax25Frame): boolean => base(f) === UA_BASE;
const isReset = (s: DataLinkSignal): boolean =>
  s.type === "DL_CONNECT_indication" || s.type === "DL_ERROR_indication";

function watch(session: Ax25ListenerSession): DataLinkSignal[] {
  const signals: DataLinkSignal[] = [];
  session.onDataLinkSignal((s) => signals.push(s));
  return signals;
}

// Our dial crosses the peer's: we send SABME, the peer's SABME arrives while
// we wait and is answered with UA, and the peer's UA to ours connects us. The
// peer never heard our UA, so it is still dialling.
async function crossingDial(quirks: Ax25SessionQuirks): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  session: Ax25ListenerSession;
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: Local, quirks });
  await listener.start();
  const connecting = listener.connect(Peer, true, false);
  await waitFor(() => sent(transport).some(isEstablish), 5000, "our SABME is on the air");
  transport.injectInbound(sabme({ destination: Local, source: Peer }));
  await waitFor(() => sent(transport).some(isUa), 5000, "the crossing SABME is answered while we wait");
  transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
  const session = await withTimeout(connecting, 10_000);
  return { listener, transport, session };
}

// A call we answer: the peer's SABME takes us from Disconnected to Connected.
async function answeredCall(t1Ms?: number): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  session: Ax25ListenerSession;
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: Local, t1Ms });
  await listener.start();
  let accepted: Ax25ListenerSession | null = null;
  listener.onSessionAccepted((s) => {
    accepted = s;
  });
  transport.injectInbound(sabme({ destination: Local, source: Peer }));
  await waitFor(() => accepted !== null, 5000, "the call is accepted");
  return { listener, transport, session: accepted as unknown as Ax25ListenerSession };
}

describe("repeatedConnectSabmReacknowledged", () => {
  it("a repeat of the crossing SABME is answered again and the data sent meanwhile stays queued", async () => {
    const { listener, transport, session } = await crossingDial(defaultSessionQuirks);
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("exchange\r"));

    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => sent(transport).filter(isUa).length === 2, 5000, "the retry is answered");

    expect(sent(transport).filter(isEstablish)).toHaveLength(1);
    expect(session.context.vs).toBe(1);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });

  it("with the quirk off the repeat resets as the figure draws and the data is discarded", async () => {
    const { listener, transport, session } = await crossingDial({
      ...defaultSessionQuirks,
      repeatedConnectSabmReacknowledged: false,
    });
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("exchange\r"));

    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => signals.some((s) => s.type === "DL_CONNECT_indication"), 5000, "the figure's reset");

    expect(session.context.vs).toBe(0);
    await listener.dispose();
  });

  it("an answered call whose UA was lost keeps the banner sent on it", async () => {
    const { listener, transport, session } = await answeredCall();
    listener.sendData(session, new TextEncoder().encode("banner\r"));

    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => sent(transport).filter(isUa).length === 2, 5000, "the repeat is answered with UA");

    expect(session.context.vs).toBe(1);
    expect(["Connected", "TimerRecovery"]).toContain(session.state);
    await listener.dispose();
  });

  it("with repeatedConnectUaIgnored, a doubled connecting UA and a doubled SABME retry are both absorbed", async () => {
    // A path that delivers every frame twice (LinBPQ with two MAP lines):
    // neither quirk's window closes the other's.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: Local, quirks: defaultSessionQuirks });
    await listener.start();
    const connecting = listener.connect(Peer, true, false);
    await waitFor(() => sent(transport).some(isEstablish), 5000, "our SABME is on the air");
    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => sent(transport).some(isUa), 5000, "the crossing SABME is answered while we wait");
    const connectingUa = ua({ destination: Local, source: Peer, finalBit: true });
    transport.injectInbound(connectingUa);
    transport.injectInbound(connectingUa);
    const session = await withTimeout(connecting, 10_000);
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("exchange\r"));

    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    transport.injectInbound(connectingUa);
    await waitFor(() => sent(transport).filter(isUa).length === 3, 5000, "both copies of the retry are answered");

    expect(sent(transport).filter(isEstablish)).toHaveLength(1);
    expect(session.context.vs).toBe(1);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });

  it("a repeat that arrives in TimerRecovery is answered again without a reset", async () => {
    // The banner's T1 has run out before the peer's retry arrives (figc4.5
    // has the same SABM(E) reset arms as figc4.4).
    const { listener, transport, session } = await answeredCall(200);
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("banner\r"));
    await waitFor(() => session.state === "TimerRecovery", 10_000, "the banner's T1 runs out");

    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => sent(transport).filter(isUa).length === 2, 5000, "the repeat is answered with UA");

    expect(session.state).toBe("TimerRecovery");
    expect(session.context.vs).toBe(1);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });

  it("a SABME after the peer has sent anything else still resets the link", async () => {
    const { listener, transport, session } = await answeredCall();
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("banner\r"));

    transport.injectInbound(rr({ destination: Local, source: Peer, nr: 0, isCommand: false, extended: true }));
    transport.injectInbound(sabme({ destination: Local, source: Peer }));
    await waitFor(() => signals.some((s) => s.type === "DL_CONNECT_indication"), 5000, "the reset after the RR");
    await listener.dispose();
  });

  it("a different SABME still resets the link", async () => {
    const { listener, transport, session } = await answeredCall();
    const signals = watch(session);
    listener.sendData(session, new TextEncoder().encode("banner\r"));

    transport.injectInbound(sabme({ destination: Local, source: Peer, pollBit: false }));
    await waitFor(() => signals.some((s) => s.type === "DL_CONNECT_indication"), 5000, "a different SABME is a reset");
    await listener.dispose();
  });
});
