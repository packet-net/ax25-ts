import {
  DataLinkAwaitingConnection,
  DataLinkAwaitingV22Connection,
  DataLinkAwaitingRelease,
  DataLinkConnected,
  DataLinkDisconnected,
  DataLinkTimerRecovery,
  type ActionStep,
  type LoopRange,
  type StatePage,
  type TransitionSpec,
} from "ax25sdl";
import type { Ax25Frame } from "../frame.js";
import {
  ActionDispatcher,
  type DataLinkSignal,
  type PendingFrame,
  type TransitionContext,
} from "./action-dispatcher.js";
import type { Ax25Event } from "./events.js";
import { GuardEvaluator } from "./guard-evaluator.js";
import { createSessionBindings } from "./session-bindings.js";
import {
  type Ax25SessionContext,
  modulus as ctxModulus,
} from "./session-context.js";
import {
  DefaultSubroutineRegistry,
  type SubroutineRegistry,
} from "./subroutine-registry.js";
import type { TimerName, TimerScheduler } from "./timer-scheduler.js";

const STATE_PAGES: Record<string, StatePage> = {
  Disconnected: DataLinkDisconnected,
  AwaitingConnection: DataLinkAwaitingConnection,
  AwaitingConnection22: DataLinkAwaitingV22Connection,
  AwaitingRelease: DataLinkAwaitingRelease,
  Connected: DataLinkConnected,
  TimerRecovery: DataLinkTimerRecovery,
};

/**
 * Optional hook fired when an event arrives that has no matching
 * transition. Defaults to dropping silently — matches SDL semantics
 * ("events in states that don't handle them are ignored").
 */
export type UnhandledEventHook = (event: Ax25Event, state: string) => void;

/** Hooks the session driver into the surrounding stack. */
export interface SessionDriverHooks {
  readonly sendFrame: (frame: Ax25Frame) => void;
  readonly emitUpward: (signal: DataLinkSignal) => void;
  readonly onUnhandledEvent?: UnhandledEventHook;
  readonly subroutines?: SubroutineRegistry;
  /** Timer durations in milliseconds. */
  readonly t1Ms?: number;
  readonly t2Ms?: number;
  readonly t3Ms?: number;
  /**
   * Suppress the SDL's SRT / T1V mutations so the dispatcher honours
   * the caller-supplied t1Ms. See {@link ActionDispatcher.freezeT1V}.
   */
  readonly freezeT1V?: boolean;
}

/**
 * Drives one connection through the SDL-generated transition tables.
 *
 * For each posted event:
 *   1. Look up the transitions for the current state.
 *   2. Filter by `on:` matching the event name.
 *   3. For each matching transition, evaluate its `guard:` against the
 *      bindings; pick the first whose guard is true.
 *   4. Run the action chain against the dispatcher, accumulating frame
 *      emissions and context mutations.
 *   5. Advance the current state to `next:`.
 *
 * Mirrors the C# `Ax25Session.PostEvent` line-for-line, with one
 * deliberate reduction: figc4.7 subroutines route through a no-op
 * registry. See {@link SubroutineRegistry}.
 */
export class SdlSessionDriver {
  readonly context: Ax25SessionContext;
  private state: string;
  private currentTrigger: Ax25Event | null = null;
  private readonly dispatcher: ActionDispatcher;
  private readonly guards: GuardEvaluator;
  private readonly subroutines: SubroutineRegistry;
  private readonly hooks: SessionDriverHooks;
  private readonly pendingEvents: Ax25Event[] = [];

  constructor(
    context: Ax25SessionContext,
    private readonly scheduler: TimerScheduler,
    hooks: SessionDriverHooks,
    initialState = "Disconnected",
  ) {
    this.context = context;
    this.state = initialState;
    this.hooks = hooks;
    this.subroutines = hooks.subroutines ?? new DefaultSubroutineRegistry();

    const bindings = createSessionBindings(
      context,
      scheduler,
      () => this.currentTrigger,
    );
    this.guards = new GuardEvaluator(bindings);

    this.dispatcher = new ActionDispatcher(
      hooks.t1Ms ?? 3000,
      hooks.t2Ms ?? 1500,
      hooks.t3Ms ?? 30000,
      (name: TimerName) => this.onTimerExpiry(name),
    );
    if (hooks.freezeT1V) this.dispatcher.freezeT1V = true;

    // Apply any caller-supplied T1 override to the context's T1V so
    // `start_T1` arms for the requested duration. The dispatcher reads
    // ctx.t1vMs each time it arms T1 — this gives tests a single knob.
    if (hooks.t1Ms !== undefined) {
      context.t1vMs = hooks.t1Ms;
    }
  }

  /** The current SDL state name. */
  get currentState(): string {
    return this.state;
  }

  /** Force the state machine into a specific state. Used at session creation. */
  setState(state: string): void {
    if (!STATE_PAGES[state]) {
      throw new Error(
        `unknown SDL state '${state}'. Known: ${Object.keys(STATE_PAGES).join(", ")}.`,
      );
    }
    this.state = state;
  }

  /** Drive one event through the state machine and any synthetic derivatives. */
  postEvent(event: Ax25Event): void {
    this.pendingEvents.push(event);
    this.drain();
  }

  private drain(): void {
    while (this.pendingEvents.length > 0) {
      const next = this.pendingEvents.shift()!;
      this.dispatchOne(next);
    }
    // After every drain, see whether conditions allow an I-frame to
    // pop off the queue. This is the synthetic-event drain the figures
    // rely on: figc4.4 t18 pushes onto IFrameQueue; t19/t20 handle the
    // synthetic pop event by emitting the I-frame on the wire. Without
    // this, DL-DATA-request would silently sit on the queue.
    this.drainIFrameQueue();
  }

  private dispatchOne(event: Ax25Event): void {
    const page = STATE_PAGES[this.state];
    if (!page) {
      throw new Error(`no SDL page for current state '${this.state}'`);
    }

    this.currentTrigger = event;
    try {
      const match = this.findMatchingTransition(page, event);
      if (!match) {
        this.hooks.onUnhandledEvent?.(event, this.state);
        return;
      }

      const pending: PendingFrame = { nr: null, ns: null, pfBit: null };
      const tx: TransitionContext = {
        context: this.context,
        scheduler: this.scheduler,
        event,
        pending,
        sendFrame: this.hooks.sendFrame,
        emitUpward: this.hooks.emitUpward,
        subroutines: this.subroutines,
        postEvent: (evt) => this.pendingEvents.push(evt),
      };
      this.executeWithLoops(match, tx);
      this.state = match.next;
    } finally {
      this.currentTrigger = null;
    }
  }

  /**
   * Execute a transition's action chain, expanding any SDL loops
   * (`loop_while`, from ax25sdl 0.7.0+). Each {@link LoopRange} marks a body
   * slice over the flat `actions` list that re-runs while its continue
   * predicate holds. Loops are non-overlapping and non-nested. A head-test
   * (`while`) loop checks the predicate before each iteration (zero-or-more
   * runs); a tail-test (`do-while`) after (one-or-more). Mirrors the C#
   * `SdlLoopExecutor`. (Subroutine bodies aren't table-walked in this port,
   * so only transition loops — the figc4.4/4.5 stored-frame drains — apply.)
   */
  private executeWithLoops(match: TransitionSpec, tx: TransitionContext): void {
    const { actions, loops } = match;
    if (loops.length === 0) {
      this.dispatcher.execute(actions, tx, this.state);
      return;
    }
    const ordered = [...loops].sort((a, b) => a.start - b.start);
    let idx = 0;
    for (const loop of ordered) {
      if (idx < loop.start) {
        this.dispatcher.execute(actions.slice(idx, loop.start), tx, this.state);
      }
      this.runLoop(loop, actions, tx);
      idx = loop.start + loop.length;
    }
    if (idx < actions.length) {
      this.dispatcher.execute(actions.slice(idx), tx, this.state);
    }
  }

  private runLoop(
    loop: LoopRange,
    actions: readonly ActionStep[],
    tx: TransitionContext,
  ): void {
    const body = actions.slice(loop.start, loop.start + loop.length);
    // Bound: the legitimate maximum is the send window (k ≤ 128); beyond this
    // the body isn't advancing the state its predicate reads — fail loudly
    // rather than spin.
    const maxIterations = 1024;
    let iterations = 0;
    const shouldContinue = (): boolean => this.guards.evaluate(loop.predicate);
    const runBody = (): void => {
      this.dispatcher.execute(body, tx, this.state);
      if (++iterations > maxIterations) {
        throw new Error(
          `SDL loop (predicate '${loop.predicate}') exceeded ${maxIterations} ` +
            `iterations without its continue predicate clearing`,
        );
      }
    };
    if (loop.testAtEnd) {
      do {
        runBody();
      } while (shouldContinue());
    } else {
      while (shouldContinue()) {
        runBody();
      }
    }
  }

  private findMatchingTransition(
    page: StatePage,
    event: Ax25Event,
  ): TransitionSpec | null {
    for (const t of page.transitions) {
      if (t.on !== event.name) continue;
      if (!this.guards.evaluate(t.guard)) continue;
      return t;
    }
    return null;
  }

  private drainIFrameQueue(): void {
    while (
      this.context.iFrameQueue.length > 0 &&
      this.canTransmitIFrame()
    ) {
      const entry = this.context.iFrameQueue.shift()!;
      this.pendingEvents.push({
        name: "I_frame_pops_off_queue",
        data: entry.data,
        pid: entry.pid,
      });
      // Recurse: dispatch the synthetic event(s) we just queued. Don't
      // recurse via drain() because that would re-drain the I-frame
      // queue twice; instead inline the dispatch.
      while (this.pendingEvents.length > 0) {
        const next = this.pendingEvents.shift()!;
        this.dispatchOne(next);
      }
    }
  }

  private canTransmitIFrame(): boolean {
    if (this.context.peerReceiverBusy) return false;
    const m = ctxModulus(this.context);
    const outstanding =
      (this.context.vs - this.context.va + m) % m;
    return outstanding < this.context.k;
  }

  private onTimerExpiry(name: TimerName): void {
    this.context.t1HadExpired = name === "T1" ? true : this.context.t1HadExpired;
    this.postEvent({ name: `${name}_expiry` });
  }
}
