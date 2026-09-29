/**
 * `unexpectedUaIgnored` - the shape of packet-net/packet.net#874 at the
 * session level. Two stations dial each other at once. Our v2.2 dial's T1 runs
 * out once, so two SABMEs are on the wire; the peer's own SABME crosses ours
 * and we answer it with UA; the peer's UA to our first SABME connects us; data
 * flows both ways; then the peer's UA to our retry arrives. figc4.4 reads that
 * late UA as the §6.5 unexpected UA and resets a link that is carrying
 * traffic. The quirk drops every UA on an up link, as LinBPQ and the Linux
 * kernel do.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, iFrame, rr, sabme, ua } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const Local = Callsign.parse("N0AAA-3");
const Peer = Callsign.parse("N0BBB-5");

// U-frame control octets (P/F masked out).
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
const isSabme = (f: Ax25Frame): boolean => base(f) === SABME_BASE;
const isUa = (f: Ax25Frame): boolean => base(f) === UA_BASE;
const isReset = (s: DataLinkSignal): boolean =>
  s.type === "DL_CONNECT_indication" || s.type === "DL_ERROR_indication";

// Replays the crossing up to the point where the peer's UA to our T1 retry is
// about to arrive: we are Connected, have received the peer's I frame S0 and
// have sent data of our own.
async function crossedDialCarryingTraffic(quirks: Ax25SessionQuirks): Promise<{
  listener: Ax25Listener;
  transport: LoopbackTransport;
  session: Ax25ListenerSession;
  signals: DataLinkSignal[];
  received: string[];
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: Local, quirks, t1Ms: 300 });
  await listener.start();
  const connecting = listener.connect(Peer, true, false);
  await waitFor(() => sent(transport).filter(isSabme).length === 2, 10_000, "our dial's T1 runs out once");

  transport.injectInbound(sabme({ destination: Local, source: Peer }));
  await waitFor(() => sent(transport).some(isUa), 5000, "the crossing SABME is answered while we wait");
  transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
  const session = await withTimeout(connecting, 10_000);
  expect(["Connected", "TimerRecovery"]).toContain(session.state);

  const signals: DataLinkSignal[] = [];
  session.onDataLinkSignal((s) => signals.push(s));
  const received: string[] = [];
  session.onData((chunk) => received.push(new TextDecoder().decode(chunk)));

  transport.injectInbound(
    iFrame({ destination: Local, source: Peer, nr: 0, ns: 0, extended: true, info: new TextEncoder().encode("hello\r") }),
  );
  await waitFor(() => received.length === 1, 5000, "the peer's first I frame is delivered");
  listener.sendData(session, new TextEncoder().encode("exchange\r"));
  await waitFor(() => session.context.vs === 1, 5000, "our data is sent");

  return { listener, transport, session, signals, received };
}

describe("unexpectedUaIgnored", () => {
  it("the UA answering our dial's T1 retry is dropped on a link carrying traffic", async () => {
    const { listener, transport, session, signals, received } =
      await crossedDialCarryingTraffic(defaultSessionQuirks);
    const sabmesBefore = sent(transport).filter(isSabme).length;

    transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
    transport.injectInbound(
      iFrame({ destination: Local, source: Peer, nr: 1, ns: 1, extended: true, info: new TextEncoder().encode("more\r") }),
    );
    await waitFor(() => received.length === 2, 5000, "the peer's next I frame is delivered");

    expect(received).toEqual(["hello\r", "more\r"]);
    expect(["Connected", "TimerRecovery"]).toContain(session.state);
    expect(sent(transport).filter(isSabme)).toHaveLength(sabmesBefore);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });

  it("with the quirk off the late UA resets the link as the figure draws", async () => {
    const { listener, transport, signals } = await crossedDialCarryingTraffic({
      ...defaultSessionQuirks,
      unexpectedUaIgnored: false,
    });
    const sabmesBefore = sent(transport).filter(isSabme).length;

    transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
    await waitFor(
      () => sent(transport).filter(isSabme).length > sabmesBefore,
      5000,
      "the figure re-establishes on the late UA",
    );
    expect(signals.some((s) => s.type === "DL_ERROR_indication")).toBe(true);
    await listener.dispose();
  });

  it("a UA in TimerRecovery is dropped too", async () => {
    // figc4.5's t11_ua_received resets the same way; the quirk covers both
    // connected states.
    const { listener, transport, session, signals } = await crossedDialCarryingTraffic(defaultSessionQuirks);
    await waitFor(() => session.state === "TimerRecovery", 10_000, "our data's T1 runs out");
    const sabmesBefore = sent(transport).filter(isSabme).length;

    transport.injectInbound(ua({ destination: Local, source: Peer, finalBit: true }));
    transport.injectInbound(rr({ destination: Local, source: Peer, nr: 1, isCommand: false, pollFinal: true, extended: true }));
    await waitFor(() => session.state === "Connected", 5000, "the RR's F=1 ends Timer Recovery");

    expect(session.context.va).toBe(1);
    expect(sent(transport).filter(isSabme)).toHaveLength(sabmesBefore);
    expect(signals.filter(isReset)).toHaveLength(0);
    await listener.dispose();
  });
});
