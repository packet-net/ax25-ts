/**
 * Connected-mode recovery runtime parity with packet.net libs 0.4.0:
 *
 *   1. figc4.7 `Invoke_Retransmission` (timeout-driven go-back-N) — the loop
 *      body verbs `X := V(s)` / `V(s) := N(r)` and the `vs_eq_X` loop
 *      terminator.
 *   2. `ax25Spec40DiscardOutOfWindowIFrames` — receive-window discard guard.
 *   3. `ax25Spec41KarnSrtSampling` — Karn's-algorithm SRT-sample gate.
 *   4. `ax25Spec42SrejTargetsGap` — retarget the SREJ to the missing gap.
 *   5. `ax25Spec47TimerRecoveryDrainAdvancesVR` — figc4.5 stored-frame drain
 *      advances V(R) (rewrite `V(r) := V(r) - 1` → `V(r) := V(r) + 1`).
 *
 * TS ports of packet.net's `DataLinkConnectedRetransmitTests` +
 * `Ax25SessionQuirksTests` (m0lte/packet.net #232/#241/#242/#246/#286).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  getNs,
  iFrame,
  rej,
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
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { DefaultSubroutineRegistry } from "../src/sdl/subroutine-registry.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

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

describe("ax25Spec40DiscardOutOfWindowIFrames quirk (packet.net#242)", () => {
  // The guard ORs an out-of-window N(S) into `reject_exception`, scoped to an
  // I_received trigger. Exercise the binding directly.
  function rejectExceptionUnder(
    quirkOn: boolean,
    event: Ax25Event,
    setup: (ctx: Ax25SessionContext) => void,
  ): boolean {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const ctx = createSessionContext(local, remote);
    ctx.quirks = quirkOn
      ? { ...defaultSessionQuirks }
      : { ...strictlyFaithfulSessionQuirks };
    setup(ctx);
    const bindings = createSessionBindings(
      ctx,
      new RealTimerScheduler(),
      () => event,
    );
    return bindings.get("reject_exception")!();
  }

  it("on: an in-window I-frame does NOT trip reject_exception", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // V(r)=0, k=4: N(s)=2 is inside [0,4). Window guard quiet.
    const r = rejectExceptionUnder(true, iReceived(local, remote, 2, 0), (ctx) => {
      ctx.vr = 0;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("on: an out-of-window (duplicate-behind-V(r)) I-frame trips reject_exception → discard path", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // V(r)=2, k=4: N(s)=7 is offset (7-2) mod 8 = 5 ≥ k=4 → out of window.
    // (A stale duplicate behind V(r) lands the same way under mod arithmetic.)
    const r = rejectExceptionUnder(true, iReceived(local, remote, 7, 0), (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(true);
  });

  it("off (strictly faithful): out-of-window I-frame does NOT trip reject_exception (figure as drawn → SREJ/REJ)", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    const r = rejectExceptionUnder(false, iReceived(local, remote, 7, 0), (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("on: the guard is inert on a non-I_received trigger even if N(s)-bits are out of window", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // RR_received carrying a control byte whose N(s)-position bits would be
    // out-of-window — must be ignored because the guard is I_received-scoped.
    const ev: Ax25Event = {
      name: "RR_received",
      frame: iFrame({ destination: local, source: remote, ns: 7, nr: 0, info: new Uint8Array([1]), pid: PID }),
    };
    const r = rejectExceptionUnder(true, ev, (ctx) => {
      ctx.vr = 2;
      ctx.k = 4;
    });
    expect(r).toBe(false);
  });

  it("on: the base reject_exception flag still reads through when set", () => {
    const local = Callsign.parse("M0LTEA");
    const remote = Callsign.parse("M0LTEB");
    // In-window frame, but the flag is already set — OR must keep it true.
    const r = rejectExceptionUnder(true, iReceived(local, remote, 1, 0), (ctx) => {
      ctx.vr = 0;
      ctx.k = 4;
      ctx.rejectException = true;
    });
    expect(r).toBe(true);
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
