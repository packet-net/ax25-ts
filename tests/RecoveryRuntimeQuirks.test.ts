/**
 * Connected-mode recovery runtime parity with packet.net libs 0.4.0:
 *
 *   1. figc4.7 `Invoke_Retransmission` (timeout-driven go-back-N) — the loop
 *      body verbs `X := V(s)` / `V(s) := N(r)` and the `vs_eq_X` loop
 *      terminator.
 *   2. `vr_lt_ns_lt_vr_plus_k` — the receive-window guard figc4.4/figc4.5
 *      now draw themselves (ax25spec#40); was the ax25Spec40 quirk.
 *   3. `ax25Spec41KarnSrtSampling` — Karn's-algorithm SRT-sample gate.
 *   4. `ax25Spec42SrejTargetsGap` — retarget the SREJ to the missing gap.
 *   5. `ax25Spec47TimerRecoveryDrainAdvancesVR` — figc4.5 stored-frame drain
 *      advances V(R) (rewrite `V(r) := V(r) - 1` → `V(r) := V(r) + 1`).
 *   6. `ax25Spec9AckProgressResetsRc` — a T1 expiry that followed V(A)-advancing
 *      progress clamps RC to 1 before the figures' `RC = N2` guard.
 *
 * TS ports of packet.net's `DataLinkConnectedRetransmitTests` +
 * `Ax25SessionQuirksTests` + `Ax25Spec9RcResetQuirkTests`
 * (m0lte/packet.net #232/#241/#242/#246/#286 + feat/link-bench).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  getNs,
  iFrame,
  rej,
  rr,
} from "../src/frame.js";
import {
  ActionDispatcher,
  type DataLinkSignal,
  type PendingFrame,
  type TransitionContext,
} from "../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../src/sdl/events.js";
import { GuardEvaluator } from "../src/sdl/guard-evaluator.js";
import { createSessionBindings } from "../src/sdl/session-bindings.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "../src/sdl/session-context.js";
import { SdlSessionDriver } from "../src/sdl/session-driver.js";
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { DefaultSubroutineRegistry } from "../src/sdl/subroutine-registry.js";
import {
  RealTimerScheduler,
  type TimerName,
  type TimerScheduler,
} from "../src/sdl/timer-scheduler.js";

const PID = 0xf0;

/**
 * A directed rig: a dispatcher + wired subroutine registry + guard evaluator,
 * all sharing one context. `currentEvent` is mutable so frame-aware bindings
 * (and the quirk-scoping checks) see the event being dispatched — the same
 * wiring the {@link SdlSessionDriver} sets up, reduced to what these directed
 * verb-level tests need. Mirrors the C# `DataLinkConnectedRetransmitTests`
 * direct-dispatcher rig.
 */
function newRig(ctx: Ax25SessionContext): {
  wire: Ax25Frame[];
  /** Dispatch `steps` under `event`; returns the PendingFrame accumulator. */
  run: (event: Ax25Event, steps: { verb: string }[]) => PendingFrame;
} {
  const scheduler = new RealTimerScheduler();
  const wire: Ax25Frame[] = [];
  const dispatcher = new ActionDispatcher(6000, 1500, 30000, () => {});

  let currentEvent: Ax25Event | null = null;
  const bindings = createSessionBindings(ctx, scheduler, () => currentEvent);
  const guards = new GuardEvaluator(bindings);
  const subroutines = new DefaultSubroutineRegistry();
  subroutines.wire(dispatcher, guards);

  const run = (event: Ax25Event, steps: { verb: string }[]): PendingFrame => {
    currentEvent = event;
    const pending: PendingFrame = { nr: null, ns: null, pfBit: null };
    const tx: TransitionContext = {
      context: ctx,
      scheduler,
      event,
      pending,
      sendFrame: (f) => wire.push(f),
      emitUpward: (_s: DataLinkSignal) => {},
      subroutines,
      postEvent: () => {},
    };
    dispatcher.execute(steps, tx, "Connected");
    return pending;
  };

  return { wire, run };
}

function rejReceived(dest: Callsign, src: Callsign, nr: number): Ax25Event {
  return {
    name: "REJ_received",
    frame: rej({ destination: dest, source: src, nr, isCommand: false, pollFinal: false }),
  };
}

function iReceived(
  dest: Callsign,
  src: Callsign,
  ns: number,
  nr: number,
): Ax25Event {
  return {
    name: "I_received",
    frame: iFrame({
      destination: dest,
      source: src,
      ns,
      nr,
      info: new Uint8Array([0x99]),
      pid: PID,
    }),
  };
}

describe("figc4.7 Invoke_Retransmission go-back-N (packet.net#232)", () => {
  it("resends every unacked frame from N(r) up to X, each with its ORIGINAL N(s)", () => {
    const local = Callsign.parse("M0LTEA-1");
    const remote = Callsign.parse("M0LTEB-2");
    const ctx = createSessionContext(local, remote);
    // A has sent four I-frames (seq 0..3); V(s)=4, V(a)=0. The peer's REJ asks
    // to go back to N(r)=1, so frames 1, 2 and 3 must be resent (X - N(r) =
    // 4 - 1 = 3 frames), each carrying its own N(s).
    ctx.vs = 4;
    ctx.va = 0;
    for (let ns = 0; ns < 4; ns++) {
      ctx.sentIFrames.set(ns, { data: new Uint8Array([ns]), pid: PID });
    }

    const { wire, run } = newRig(ctx);
    run(rejReceived(local, remote, 1), [{ verb: "Invoke Retransmission" }]);

    const iframes = wire.filter((f) => classify(f) === "I");
    // go-back-N resends seq 1, 2 and 3 in order, each with its ORIGINAL N(s)
    // — not renumbered to V(s). This only works if `X := V(s)` saved 4,
    // `V(s) := N(r)` rewound to 1, the do-while body re-emitted at the rewound
    // V(s) via "Push Old I Frame onto Queue", `V(s) := V(s) + 1` advanced, and
    // the `vs_eq_X` predicate terminated the loop at V(s)=4.
    expect(iframes.map((f) => getNs(f))).toEqual([1, 2, 3]);
    expect(iframes.map((f) => f.info[0])).toEqual([1, 2, 3]);
    // V(s) is restored to X (the saved V(s)) after the retransmit loop.
    expect(ctx.vs).toBe(4);
  });

  it("X := V(s) and V(s) := N(r) verbs no longer throw (were unbound default)", () => {
    const local = Callsign.parse("M0LTEA-1");
    const remote = Callsign.parse("M0LTEB-2");
    const ctx = createSessionContext(local, remote);
    ctx.vs = 5;
    const { run } = newRig(ctx);
    // The figc4.7-verbatim `:=` spellings the walker emits.
    run(rejReceived(local, remote, 2), [
      { verb: "X := V(s)" },
      { verb: "V(s) := N(r)" },
    ]);
    expect(ctx.x).toBe(5); // X snapshotted the pre-rewind V(s)
    expect(ctx.vs).toBe(2); // V(s) rewound to the peer's N(r)
  });
});

describe("ax25Spec42SrejTargetsGap quirk (packet.net#246)", () => {
  const local = Callsign.parse("M0LTEA");
  const remote = Callsign.parse("M0LTEB");

  it("on (default): N(r) := N(s) on an I_received trigger retargets to V(r)", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...defaultSessionQuirks };
    ctx.vr = 2; // the next still-missing frame
    // Out-of-sequence I-frame N(s)=5 arrives while V(r)=2. The figure would
    // SREJ N(r):=N(s)=5 (the frame that just arrived); the quirk retargets to
    // V(r)=2 — the real gap.
    const pending = newRig(ctx).run(iReceived(local, remote, 5, 0), [
      { verb: "N(r) := N(s)" },
    ]);
    expect(pending.nr).toBe(2); // V(r), not N(s)=5
  });

  it("off (strictly faithful): N(r) := N(s) requests the just-arrived frame", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...strictlyFaithfulSessionQuirks };
    ctx.vr = 2;
    const pending = newRig(ctx).run(iReceived(local, remote, 5, 0), [
      { verb: "N(r) := N(s)" },
    ]);
    expect(pending.nr).toBe(5); // figure as drawn: the just-arrived N(s)
  });

  it("on, but a non-I_received trigger leaves N(r) := N(s) alone", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...defaultSessionQuirks };
    ctx.vr = 2;
    // RR_received, not I_received — the rewrite must be inert here.
    const ev: Ax25Event = {
      name: "RR_received",
      frame: iFrame({ destination: local, source: remote, ns: 5, nr: 0, info: new Uint8Array([1]), pid: PID }),
    };
    const pending = newRig(ctx).run(ev, [{ verb: "N(r) := N(s)" }]);
    expect(pending.nr).toBe(5); // untouched — N(s) of the trigger
  });
});

describe("vr_lt_ns_lt_vr_plus_k receive-window guard (ax25spec#40)", () => {
  // figc4.4 and figc4.5 draw this as a decision on the out-of-sequence arm
  // since Packet.Ax25.Sdl 0.11.0, so it is bound as an atom rather than OR'd
  // into `reject_exception` by the quirk that used to stand in for it. That
  // means it holds under the strictly-faithful preset too, which the last case
  // here is the point of.
  function inWindowUnder(
    quirks: "default" | "strictlyFaithful",
    event: Ax25Event,
    setup: (ctx: Ax25SessionContext) => void,
  ): boolean {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.quirks =
      quirks === "default"
        ? { ...defaultSessionQuirks }
        : { ...strictlyFaithfulSessionQuirks };
    setup(ctx);
    const bindings = createSessionBindings(
      ctx,
      new RealTimerScheduler(),
      () => event,
    );
    return bindings.get("vr_lt_ns_lt_vr_plus_k")!();
  }

  it("an in-window out-of-sequence I-frame reads as in window (a real gap, SREJ/REJ it)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // V(r)=0, k=4: N(s)=2 is inside the open interval (0, 4).
    const r = inWindowUnder("default", iReceived(local, remote, 2, 0), (ctx) => {
      ctx.vr = 0;
      ctx.k = 4;
    });
    expect(r).toBe(true);
  });

  it("a duplicate behind V(r) reads as out of window (discard, raise nothing)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // V(r)=2, k=4: N(s)=7 is offset (7-2) mod 8 = 5, past the granted window.
    const r = inWindowUnder("default", iReceived(local, remote, 7, 0), (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("V(r)+k itself is out of window (the interval is open at the top)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // V(r)=0, k=4: N(s)=4 is the first sequence number past the window.
    const r = inWindowUnder("default", iReceived(local, remote, 4, 0), (ctx) => {
      ctx.vr = 0;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("reads the effective window, not the raw k (the SREJ half-modulus clamp)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // k=7 but SREJ clamps the granted window to 4 at mod-8, so N(s)=5 is
    // inside the configured k and outside what this receiver actually granted.
    const r = inWindowUnder("default", iReceived(local, remote, 5, 0), (ctx) => {
      ctx.vr = 0;
      ctx.k = 7;
      ctx.srejEnabled = true;
    });
    expect(r).toBe(false);
  });

  it("holds under the strictly-faithful preset (it is the figure now, not a quirk)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const r = inWindowUnder("strictlyFaithful", iReceived(local, remote, 7, 0), (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("is inert on a non-I_received trigger", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ev: Ax25Event = {
      name: "RR_received",
      frame: rr({ destination: local, source: remote, nr: 0, command: true, pollFinal: false }),
    };
    const r = inWindowUnder("default", ev, (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });
});

describe("ax25Spec41KarnSrtSampling quirk (packet.net#241)", () => {
  // The figc4.7 Select_T1 subroutine emits the `:=` spelling.
  const SRT_VERB =
    "SRT := 7(SRT)/8 + (T1)/8 - (Remaining Time on T1 When Last Stopped)/8";

  function srtAfter(
    quirkOn: boolean,
    t1RemainingWhenLastStoppedMs: number,
  ): number {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.quirks = quirkOn
      ? { ...defaultSessionQuirks }
      : { ...strictlyFaithfulSessionQuirks };
    ctx.srtMs = 1000;
    ctx.t1vMs = 2000; // = 2·SRT
    ctx.t1RemainingWhenLastStoppedMs = t1RemainingWhenLastStoppedMs;
    const { run } = newRig(ctx);
    run({ name: "T1_expiry" }, [{ verb: SRT_VERB }]);
    return ctx.srtMs;
  }

  it("on: no clean measurement (remaining=0) → SRT left UNCHANGED (Karn skip)", () => {
    // The retransmit/timeout path: T1RemainingWhenLastStopped==0. Without the
    // guard the sample degenerates to full T1V (2·SRT) and SRT self-amplifies
    // to 1.125·SRT. With the guard on, SRT is untouched.
    expect(srtAfter(true, 0)).toBe(1000);
  });

  it("on: a clean round-trip (remaining>0) → SRT IIR still runs", () => {
    // T1 ran 2000ms, stopped by an ack with 1200ms remaining: sample = 800ms.
    // SRT' = 0.875·1000 + 0.125·800 = 975.
    expect(srtAfter(true, 1200)).toBeCloseTo(975, 6);
  });

  it("off (strictly faithful): SRT self-amplifies even with no clean measurement", () => {
    // Figure as drawn: sample = T1V - 0 = 2000; SRT' = 0.875·1000 + 0.125·2000
    // = 1125 (the divergent 1.125·SRT growth #41 describes).
    expect(srtAfter(false, 0)).toBeCloseTo(1125, 6);
  });

  it("clears t1HadExpired and t1RemainingWhenLastStopped regardless of the guard", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...defaultSessionQuirks };
    ctx.t1HadExpired = true;
    ctx.t1RemainingWhenLastStoppedMs = 0; // Karn-skip path
    const { run } = newRig(ctx);
    run({ name: "T1_expiry" }, [{ verb: SRT_VERB }]);
    expect(ctx.t1HadExpired).toBe(false);
    expect(ctx.t1RemainingWhenLastStoppedMs).toBe(0);
  });
});

describe("ax25Spec47TimerRecoveryDrainAdvancesVR quirk (packet.net#286)", () => {
  const local = Callsign.parse("M0LTEA");
  const remote = Callsign.parse("M0LTEB");

  // The drain verb is unique to the three figc4.5 (Timer Recovery) stored-frame
  // drain loops; the rewrite fires on the verb alone (no trigger gate), so an
  // I_received trigger faithfully stands in for the drain context.
  const drainEvent = (): Ax25Event => iReceived(local, remote, 0, 0);

  it("on (default): V(r) := V(r) - 1 is rewritten to advance V(R) (figc4.4 parity)", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...defaultSessionQuirks };
    ctx.vr = 1; // pre-loop increment already moved V(r) to 1
    newRig(ctx).run(drainEvent(), [{ verb: "V(r) := V(r) - 1" }]);
    // The drain must ADVANCE past the just-delivered stored frame: 1 → 2, not 1 → 0.
    expect(ctx.vr).toBe(2);
  });

  it("off (strictly faithful): V(r) := V(r) - 1 runs as drawn and decrements V(R)", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...strictlyFaithfulSessionQuirks };
    ctx.vr = 1;
    newRig(ctx).run(drainEvent(), [{ verb: "V(r) := V(r) - 1" }]);
    // Figure as drawn: the decrement cancels the pre-loop increment (1 → 0), the
    // defect that leaves V(R) under-advanced. (mod-8 wrap: decrementSeq(0-base).)
    expect(ctx.vr).toBe(0);
  });

  it("on: the rewrite is inert for V(r) := V(r) + 1 (already correct) and other verbs", () => {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...defaultSessionQuirks };
    ctx.vr = 1;
    // figc4.4's drain already uses +1 — the rewrite must leave it (and any other
    // V(r) assignment) untouched, advancing exactly once.
    newRig(ctx).run(drainEvent(), [{ verb: "V(r) := V(r) + 1" }]);
    expect(ctx.vr).toBe(2);
  });
});

describe("ax25Spec9AckProgressResetsRc quirk (packet.net feat/link-bench, ax25spec#9)", () => {
  const local = Callsign.parse("M0LTE");
  const remote = Callsign.parse("G7XYZ-7");

  /**
   * Deterministic manually-clocked scheduler — timers fire only on an explicit
   * {@link ManualScheduler.advance}. The TS analogue of packet.net's
   * `FakeTimeProvider` + `SystemTimerScheduler`. (These tests drive T1 expiry by
   * posting the `T1_expiry` event directly, mirroring the C# test's
   * `session.PostEvent(new T1Expiry())`, so the scheduler is only here to satisfy
   * the driver's arming/cancelling of timers without a real clock.)
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
  }

  /**
   * A session parked mid-recovery in Timer Recovery: three I-frames in flight
   * (V(s)=3, V(a)=0), several T1 hiccups already on RC. Mirrors the C#
   * `NewTimerRecoverySession` fixture.
   */
  function newTimerRecoverySession(
    quirks: Ax25SessionContext["quirks"],
  ): { driver: SdlSessionDriver; ctx: Ax25SessionContext } {
    const ctx = createSessionContext(local, remote);
    ctx.quirks = { ...quirks };
    ctx.vs = 3;
    ctx.va = 0;
    ctx.rc = 7;
    for (let ns = 0; ns < 3; ns++) {
      ctx.sentIFrames.set(ns, { data: new Uint8Array([ns]), pid: PID });
    }
    const driver = new SdlSessionDriver(ctx, new ManualScheduler(), {
      sendFrame: () => {},
      emitUpward: () => {},
      freezeT1V: true,
      t1Ms: 1000,
    });
    driver.setState("TimerRecovery");
    return { driver, ctx };
  }

  /** Inbound mod-8 RR response addressed to us, N(R)=`nr`, F=0. */
  function rrResponse(nr: number): Ax25Event {
    return {
      name: "RR_received",
      frame: rr({
        destination: local,
        source: remote,
        nr,
        isCommand: false,
        pollFinal: false,
      }),
    };
  }

  it("on: a T1 expiry after ack progress clamps RC to 1 (before RC=N2)", () => {
    const { driver, ctx } = newTimerRecoverySession(defaultSessionQuirks);

    // An ack advances V(A) (progress — the link is alive) …
    driver.postEvent(rrResponse(1));
    expect(ctx.va).toBe(1); // the RR acknowledged frame 0
    // RC is untouched at ack time — RC==0 is Select_T1's Karn sampling signal,
    // so the clamp waits for the next T1 expiry.
    expect(ctx.rc).toBe(7);

    // … so the NEXT T1 expiry starts a fresh consecutive-failure run: the expiry
    // clamps RC to 1 BEFORE the RC=N2 guard, then the figure's own RC:=RC+1 runs.
    driver.postEvent({ name: "T1_expiry" });
    expect(ctx.rc).toBe(2);
    // With RC clamped below N2 the link re-polls instead of dying.
    expect(driver.currentState).toBe("TimerRecovery");
  });

  it("on: a T1 expiry with no progress keeps ratcheting (a dead link still exhausts N2)", () => {
    const { driver, ctx } = newTimerRecoverySession(defaultSessionQuirks);

    // A duplicate ack (N(R)=V(A)) acknowledges nothing new — no progress.
    driver.postEvent(rrResponse(0));
    expect(ctx.va).toBe(0); // N(R)=V(A) acknowledges nothing new

    driver.postEvent({ name: "T1_expiry" });
    // No forward progress since the last expiry — the consecutive-failure
    // ratchet continues toward N2.
    expect(ctx.rc).toBe(8);
  });

  it("on: progress then silence dies after N2 consecutive failures, not before", () => {
    const { driver, ctx } = newTimerRecoverySession(defaultSessionQuirks);

    // Progress resets the run …
    driver.postEvent(rrResponse(1));

    // … then the peer goes silent: N2 consecutive unanswered expiries must still
    // kill the link (the watchdog is weakened only against hiccups on a
    // progressing link, never against a genuinely dead one).
    for (let i = 0; i < ctx.n2; i++) {
      expect(driver.currentState).toBe("TimerRecovery"); // within the N2 budget
      driver.postEvent({ name: "T1_expiry" });
    }

    // RC reached N2 with no intervening progress — genuine link failure.
    expect(driver.currentState).toBe("Disconnected");
  });

  it("off (strictly faithful): RC ratchets across a working link (figure as drawn)", () => {
    const { driver, ctx } = newTimerRecoverySession(strictlyFaithfulSessionQuirks);

    driver.postEvent(rrResponse(1));
    expect(ctx.va).toBe(1); // the figure's ack processing is untouched

    driver.postEvent({ name: "T1_expiry" });
    // As drawn, progress never clamps RC — only the fully-acked checkpoint path
    // resets it.
    expect(ctx.rc).toBe(8);
  });
});
