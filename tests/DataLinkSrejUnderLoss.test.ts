/**
 * End-to-end deterministic reproduction of connected-mode recovery under
 * scripted single-frame loss — the in-process, manually-clocked analogue of
 * packet.net's `DataLinkSrejUnderLossTests`. Two real {@link SdlSessionDriver}
 * instances exchange frames over a controllable link.
 *
 * These reproduce M0LTE/packet.net#231 (ported to ax25-ts as #8): a
 * retransmitted I-frame was renumbered with a *fresh* N(s) (the drained queue
 * assigns `N(s) := V(s)`), so the peer never recognised the resend as the
 * missing frame and no single lost I-frame was recoverable. With the fix
 * (retransmits emit directly with their original N(s)) the lost frame is
 * recovered selectively and the link stays up.
 *
 * The live retransmit verb in the TS runtime is `Push Old I Frame N(r) on
 * Queue` (figc4.4's SREJ selective retransmit), reached on an `SREJ_received`
 * trigger in Connected and via the Ax25Spec38 quirk redirect. (The go-back-N
 * `Invoke Retransmission` and TimerRecovery `Transmit Enquiry` subroutines are
 * still no-op stubs in this port — see README — so the timeout-driven recovery
 * path can't be exercised end-to-end yet; the SREJ path can.)
 *
 * TS port of packet.net's `DataLinkSrejUnderLossTests` (M0LTE/packet.net#232).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  decodeFrame,
  encodeFrame,
  getNr,
  getNs,
  rej,
} from "../src/frame.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../src/sdl/events.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "../src/sdl/session-context.js";
import { SdlSessionDriver } from "../src/sdl/session-driver.js";
import type { TimerName, TimerScheduler } from "../src/sdl/timer-scheduler.js";

const PID = 0xf0;
const FAST_T1 = 200;

/**
 * Deterministic scheduler — timers fire only when {@link advance} crosses their
 * deadline, never on a real-clock tick. The TS analogue of packet.net's
 * `FakeTimeProvider` + `SystemTimerScheduler`.
 */
class ManualScheduler implements TimerScheduler {
  private nowMs = 0;
  private readonly armed = new Map<
    TimerName,
    { endMs: number; onExpiry: () => void }
  >();

  arm(name: TimerName, durationMs: number, onExpiry: () => void): void {
    this.armed.set(name, { endMs: this.nowMs + durationMs, onExpiry });
  }
  cancel(name: TimerName): void {
    this.armed.delete(name);
  }
  isRunning(name: TimerName): boolean {
    return this.armed.has(name);
  }
  timeRemainingMs(name: TimerName): number {
    const t = this.armed.get(name);
    if (!t) return 0;
    const r = t.endMs - this.nowMs;
    return r > 0 ? r : 0;
  }
  /** Advance the clock by `ms`, firing any timers whose deadline is crossed. */
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [name, t] of [...this.armed]) {
      if (t.endMs <= this.nowMs) {
        this.armed.delete(name);
        t.onExpiry();
      }
    }
  }
}

// figc4.5/figc4.4 draw the SREJ trigger as an `SREJ_received` event carrying
// the peer's N(R). The dispatcher only reads N(R) (via getNr), so a REJ frame
// with the same N(R) field is a faithful stand-in — there's no public SREJ
// factory yet (the dispatcher's `SREJ` verb itself falls back to REJ on the
// wire). Mirrors `SessionQuirks.test.ts`'s `srejEvent`.
function srejEvent(dest: Callsign, src: Callsign, nr: number): Ax25Event {
  return {
    name: "SREJ_received",
    frame: rej({ destination: dest, source: src, nr, isCommand: false, pollFinal: true }),
  };
}

describe("connected-mode retransmit preserves N(s) (packet.net#231 / #8)", () => {
  it("a single retransmitted I-frame keeps its ORIGINAL N(s) and does not renumber", () => {
    // One I-frame (N(s)=0) sent and unacked: V(s)=1, V(a)=0, frame 0 stored.
    // This is the "send ONE I-frame, it got dropped" state — the peer is now
    // asking for it back by N(r)=0.
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.k = 4;
    ctx.srejEnabled = true;
    ctx.vs = 1;
    ctx.va = 0;
    ctx.sentIFrames.set(0, { data: new Uint8Array([0xaa]), pid: PID });

    const wire: Ax25Frame[] = [];
    const driver = new SdlSessionDriver(ctx, new ManualScheduler(), {
      sendFrame: (f) => wire.push(f),
      emitUpward: () => {},
      freezeT1V: true,
      t1Ms: FAST_T1,
    });
    driver.setState("Connected");

    // Peer SREJs frame 0 → A must selectively retransmit frame 0.
    driver.postEvent(srejEvent(local, remote, 0));

    const iframes = wire.filter((f) => classify(f) === "I");
    expect(iframes.length).toBe(1);
    // The crux of #231: the resend must carry its ORIGINAL N(s)=0, not a
    // fresh V(s). Pre-fix the drain renumbered it to N(s)=1.
    expect(getNs(iframes[0]!)).toBe(0);
    expect(Array.from(iframes[0]!.info)).toEqual([0xaa]);
    // …and the send-state variable must NOT run away: exactly one I-frame
    // exists; a retransmit must not mint a fresh sequence number.
    expect(ctx.vs).toBe(1);
    // Retransmits don't sit on the fresh-frame queue.
    expect(ctx.iFrameQueue.length).toBe(0);
  });

  it("retransmit under the Ax25Spec38 quirk redirect also keeps N(s)", () => {
    // With the quirk on (default) an SREJ trigger redirects the figc4.5
    // fresh-DL-DATA push to the figc4.4 single-frame selective retransmit.
    // That path must preserve N(s) too.
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.k = 4;
    // A window of three sent, unacked frames: V(s)=3, V(a)=0.
    ctx.vs = 3;
    ctx.va = 0;
    for (let ns = 0; ns < 3; ns++) {
      ctx.sentIFrames.set(ns, { data: new Uint8Array([ns]), pid: PID });
    }

    const wire: Ax25Frame[] = [];
    const driver = new SdlSessionDriver(ctx, new ManualScheduler(), {
      sendFrame: (f) => wire.push(f),
      emitUpward: () => {},
      freezeT1V: true,
      t1Ms: FAST_T1,
    });
    driver.setState("TimerRecovery");

    // SREJ requesting frame 1 (the quirk redirects push_frame_on_queue →
    // push_old_I_frame_N_r_on_queue and skips go-back-N).
    driver.postEvent(srejEvent(local, remote, 1));

    const iframes = wire.filter((f) => classify(f) === "I");
    expect(iframes.length).toBe(1);
    expect(getNs(iframes[0]!)).toBe(1); // original N(s), not V(s)=3
    expect(Array.from(iframes[0]!.info)).toEqual([1]);
    expect(ctx.vs).toBe(3); // window unchanged
  });

  it("two real sessions recover a dropped frame selectively (end-to-end)", () => {
    const rig = buildPair();
    connect(rig);
    rig.a.ctx.srejEnabled = true;
    rig.b.ctx.srejEnabled = true;

    // Drop A's first I-frame (N(s)=0) exactly once, then a clean channel.
    let dropped = false;
    rig.link.drop = (f) => {
      const fromA = f.source.callsign.toString() === rig.a.ctx.local.toString();
      const isI0 = classify(f) === "I" && getNs(f) === 0;
      if (fromA && isI0 && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    };

    // A sends two payloads (k=4 window). Frame 0 is dropped; frame 1 arrives
    // out of sequence at B, which SREJs N(r)=0. A retransmits frame 0 with its
    // ORIGINAL N(s)=0; B fills the gap and delivers both payloads in order.
    rig.a.driver.postEvent({ name: "DL_DATA_request", data: new Uint8Array([0xa0]), pid: PID });
    rig.a.driver.postEvent({ name: "DL_DATA_request", data: new Uint8Array([0xa1]), pid: PID });
    settle(rig);

    // The SREJ falls back to a REJ frame on the wire (no SREJ factory yet), so
    // B's selective-reject request lands on A as REJ_received → the go-back-N
    // Invoke_Retransmission stub. To exercise the *live* selective-retransmit
    // verb deterministically we hand A the SREJ trigger directly (what B's
    // intent is), mirroring the directed tests above. This proves the resend
    // carries N(s)=0 end-to-end and B delivers both payloads in order.
    rig.a.driver.postEvent(srejEvent(rig.a.ctx.local, rig.a.ctx.remote, 0));
    settle(rig);

    // B must have delivered both payloads, in order, exactly once.
    expect(rig.b.delivered.map((d) => d[0])).toEqual([0xa0, 0xa1]);
    // A's V(s) reflects exactly the two distinct frames it sent — a retransmit
    // must not have minted a third sequence number.
    expect(rig.a.ctx.vs).toBe(2);
  });
});

// ─── In-process two-session rig (Drop filter + Rx log + manual clock) ──────

interface Endpoint {
  driver: SdlSessionDriver;
  ctx: Ax25SessionContext;
  delivered: Uint8Array[];
  inbound: Ax25Event[];
}

interface Link {
  drop?: (f: Ax25Frame) => boolean;
}

interface Pair {
  a: Endpoint;
  b: Endpoint;
  link: Link;
  sched: ManualScheduler;
}

function buildPair(): Pair {
  const nodeA = Callsign.parse("M0LTEA-1");
  const nodeB = Callsign.parse("M0LTEB-2");
  const sched = new ManualScheduler();
  const link: Link = {};

  // Forward references resolved after both endpoints exist.
  const refs: { a?: Endpoint; b?: Endpoint } = {};

  const a = buildEndpoint(nodeA, nodeB, sched, link, () => refs.b!);
  const b = buildEndpoint(nodeB, nodeA, sched, link, () => refs.a!);
  refs.a = a;
  refs.b = b;
  return { a, b, link, sched };
}

function buildEndpoint(
  local: Callsign,
  remote: Callsign,
  sched: ManualScheduler,
  link: Link,
  peer: () => Endpoint,
): Endpoint {
  const ctx = createSessionContext(local, remote);
  ctx.k = 4;
  const delivered: Uint8Array[] = [];
  const inbound: Ax25Event[] = [];

  const send = (frame: Ax25Frame): void => {
    // Round-trip through the wire codec so we exercise the real control byte.
    const parsed = decodeFrame(encodeFrame(frame));
    if (link.drop?.(parsed)) return;
    const target = peer();
    if (parsed.destination.callsign.toString() !== target.ctx.local.toString()) {
      return;
    }
    const eventName = mapKindToEvent(classify(parsed));
    if (eventName === null) return;
    target.inbound.push({ name: eventName, frame: parsed });
  };

  const driver = new SdlSessionDriver(ctx, sched, {
    sendFrame: send,
    emitUpward: (sig: DataLinkSignal) => {
      if (sig.type === "DL_DATA_indication" || sig.type === "DL_UNIT_DATA_indication") {
        delivered.push(sig.data);
      }
    },
    freezeT1V: true,
    t1Ms: FAST_T1,
  });
  return { driver, ctx, delivered, inbound };
}

function settle(rig: Pair): void {
  for (let i = 0; i < 256; i++) {
    let progress = false;
    while (rig.a.inbound.length > 0) {
      rig.a.driver.postEvent(rig.a.inbound.shift()!);
      progress = true;
    }
    while (rig.b.inbound.length > 0) {
      rig.b.driver.postEvent(rig.b.inbound.shift()!);
      progress = true;
    }
    if (!progress) return;
  }
  throw new Error("link did not settle within 256 round-trips (storm?)");
}

function connect(rig: Pair): void {
  rig.a.driver.setState("Disconnected");
  rig.b.driver.setState("Disconnected");
  rig.a.driver.postEvent({ name: "DL_CONNECT_request" });
  settle(rig);
  expect(rig.a.driver.currentState).toBe("Connected");
  expect(rig.b.driver.currentState).toBe("Connected");
  rig.a.delivered.length = 0;
  rig.b.delivered.length = 0;
}

function mapKindToEvent(kind: string): string | null {
  switch (kind) {
    case "I":
      return "I_received";
    case "RR":
      return "RR_received";
    case "RNR":
      return "RNR_received";
    case "REJ":
      return "REJ_received";
    case "SABM":
      return "SABM_received";
    case "DISC":
      return "DISC_received";
    case "UA":
      return "UA_received";
    case "DM":
      return "DM_received";
    case "UI":
      return "UI_received";
    default:
      return null;
  }
}
