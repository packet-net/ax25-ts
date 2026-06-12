/**
 * The `ax25Spec9AckProgressResetsRc` session quirk (packethacking/ax25spec#9).
 * The figures only reset the retry counter RC on the Timer-Recovery
 * fully-acked checkpoint (V(S)=V(A) → Connected), so a sustained transfer
 * that lives in Timer Recovery with frames always in flight ratchets RC
 * across a *working* link and dies (DL-ERROR I → DM) at the N2'th lifetime
 * T1 hiccup — reproduced by packet.net's tools/Packet.LinkBench over
 * net-sim. With the quirk on (default), a T1 expiry that follows
 * V(A)-advancing progress clamps RC to 1 before the RC=N2 guard runs: the
 * peer acking new data is the proof of life RC exists to test, so RC counts
 * *consecutive* recovery failures. The clamp happens at expiry time (not
 * eagerly at ack time) because RC==0 doubles as Select_T1's Karn sampling
 * signal. With it off (strictlyFaithful) the figures run as drawn.
 *
 * TS port of packet.net's `Ax25Spec9RcResetQuirkTests`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, rr } from "../src/frame.js";
import type { Ax25Event } from "../src/sdl/events.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "../src/sdl/session-context.js";
import { SdlSessionDriver } from "../src/sdl/session-driver.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import type { TimerName, TimerScheduler } from "../src/sdl/timer-scheduler.js";

const PID = 0xf0;

/** Inert scheduler: transitions can arm/cancel freely; nothing ever fires.
 * T1 expiries are posted directly as events by the tests. */
class InertScheduler implements TimerScheduler {
  private readonly armed = new Set<TimerName>();
  arm(name: TimerName, _durationMs: number, _onExpiry: () => void): void {
    this.armed.add(name);
  }
  cancel(name: TimerName): void {
    this.armed.delete(name);
  }
  isRunning(name: TimerName): boolean {
    return this.armed.has(name);
  }
  timeRemainingMs(_name: TimerName): number {
    return 0;
  }
}

/** Mid-recovery shape: three I-frames in flight, several T1 hiccups on the clock. */
function newTimerRecoveryDriver(quirks: Ax25SessionQuirks): {
  driver: SdlSessionDriver;
  ctx: Ax25SessionContext;
} {
  const local = Callsign.parse("M0LTE");
  const remote = Callsign.parse("G7XYZ-7");
  const ctx = createSessionContext(local, remote);
  ctx.quirks = quirks;
  ctx.vs = 3;
  ctx.va = 0;
  ctx.rc = 7;
  for (let ns = 0; ns < 3; ns++) {
    ctx.sentIFrames.set(ns, { data: new Uint8Array([ns]), pid: PID });
  }

  const wire: Ax25Frame[] = [];
  const driver = new SdlSessionDriver(ctx, new InertScheduler(), {
    sendFrame: (f) => wire.push(f),
    emitUpward: () => {},
  });
  driver.setState("TimerRecovery");
  return { driver, ctx };
}

/** Inbound RR response addressed to us, F=0, with the given N(R). */
function rrResponse(
  ctx: Ax25SessionContext,
  nr: number,
): Ax25Event {
  return {
    name: "RR_received",
    frame: rr({
      destination: ctx.local,
      source: ctx.remote,
      nr,
      isCommand: false,
      pollFinal: false,
    }),
  };
}

describe("ax25Spec9AckProgressResetsRc (packethacking/ax25spec#9)", () => {
  it("a T1 expiry after ack progress clamps RC to 1", () => {
    const { driver, ctx } = newTimerRecoveryDriver(defaultSessionQuirks);

    // An ack advances V(A) (progress — the link is alive) …
    driver.postEvent(rrResponse(ctx, 1));
    expect(ctx.va).toBe(1); // the RR acknowledged frame 0
    // RC untouched at ack time — RC==0 is Select_T1's Karn sampling signal,
    // so the clamp waits for the next T1 expiry.
    expect(ctx.rc).toBe(7);

    // … so the NEXT T1 expiry starts a fresh consecutive-failure run: the
    // clamp to 1 runs BEFORE the rc_eq_n2 guard, then the figure's own
    // RC := RC + 1.
    driver.postEvent({ name: "T1_expiry" });
    expect(ctx.rc).toBe(2);
    // With RC clamped below N2 the link re-polls instead of dying.
    expect(driver.currentState).toBe("TimerRecovery");
  });

  it("a T1 expiry with no progress keeps ratcheting, so a dead link still exhausts N2", () => {
    const { driver, ctx } = newTimerRecoveryDriver(defaultSessionQuirks);

    // A duplicate ack (N(R)=V(A)) acknowledges nothing new — no progress.
    driver.postEvent(rrResponse(ctx, 0));
    expect(ctx.va).toBe(0);

    driver.postEvent({ name: "T1_expiry" });
    // No forward progress since the last expiry — the consecutive-failure
    // ratchet continues toward N2.
    expect(ctx.rc).toBe(8);
  });

  it("progress then silence dies after N2 consecutive failures, not before", () => {
    const { driver, ctx } = newTimerRecoveryDriver(defaultSessionQuirks);

    // Progress resets the run …
    driver.postEvent(rrResponse(ctx, 1));

    // … then the peer goes silent: N2 consecutive unanswered expiries must
    // still kill the link (the watchdog is weakened only against hiccups on
    // a progressing link, never against a genuinely dead one).
    for (let i = 0; i < ctx.n2; i++) {
      expect(driver.currentState).toBe("TimerRecovery");
      driver.postEvent({ name: "T1_expiry" });
    }

    // RC reached N2 with no intervening progress — genuine link failure.
    expect(driver.currentState).toBe("Disconnected");
  });

  it("strictlyFaithful runs the figure as drawn: RC ratchets across a working link", () => {
    const { driver, ctx } = newTimerRecoveryDriver(strictlyFaithfulSessionQuirks);

    driver.postEvent(rrResponse(ctx, 1));
    expect(ctx.va).toBe(1); // the figure's ack processing is untouched

    driver.postEvent({ name: "T1_expiry" });
    // As drawn, progress never clamps RC — only the fully-acked checkpoint
    // path resets it.
    expect(ctx.rc).toBe(8);
  });
});
