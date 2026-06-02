import {
  DataLinkAwaitingConnection,
  DataLinkAwaitingV22Connection,
  DataLinkAwaitingRelease,
  DataLinkConnected,
  DataLinkDisconnected,
  DataLinkTimerRecovery,
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
import { executeWithLoops } from "./sdl-loop-executor.js";
import {
  DefaultSubroutineRegistry,
  type SubroutineRegistry,
} from "./subroutine-registry.js";
import type { TimerName, TimerScheduler } from "./timer-scheduler.js";

// Keyed by the SDL state name (the `state` field on each generated page, and
// the `next` field every transition targets). The figc4.6 page's own name is
// `AwaitingV22Connection`, and its transitions target `AwaitingV22Connection` /
// `AwaitingConnection` / `Connected` / `Disconnected` — so the key MUST be the
// SDL spelling for a `match.next` lookup to resolve once a session routes into
// it (which the ax25Spec44 redirect below now makes reachable for the first
// time). Mirrors the C# TransitionMap keying (`["AwaitingV22Connection"] =
// DataLink_AwaitingV22Connection.Transitions`).
const STATE_PAGES: Record<string, StatePage> = {
  Disconnected: DataLinkDisconnected,
  AwaitingConnection: DataLinkAwaitingConnection,
  AwaitingV22Connection: DataLinkAwaitingV22Connection,
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

/**
 * Optional hook fired when a transition matches and is about to execute,
 * carrying the matched {@link TransitionSpec}. The TS analogue of the C#
 * `Ax25Session.TransitionFired` event — lets the conformance harness build a
 * behavioural transition-coverage ledger (`(spec.from, spec.id)`). Fired with
 * the *real* matched spec (its figc4.x `from`/`id`), before any quirk rewrites
 * the target state, so the ledger records the figure transition that actually
 * fired. Default: nothing observes transitions.
 */
export type TransitionFiredHook = (spec: TransitionSpec, state: string) => void;

/** Hooks the session driver into the surrounding stack. */
export interface SessionDriverHooks {
  readonly sendFrame: (frame: Ax25Frame) => void;
  readonly emitUpward: (signal: DataLinkSignal) => void;
  readonly onUnhandledEvent?: UnhandledEventHook;
  readonly onTransitionFired?: TransitionFiredHook;
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

    // Upgrade the default registry's no-op subroutine stubs to figc4.7 table
    // walkers now that the dispatcher + guards exist. A caller-supplied
    // registry is left as-is (the caller is responsible for wiring it). This is
    // what makes Enquiry_Response / Select_T1 / Check_I_Frame_Acknowledged etc.
    // actually run rather than no-op — ax25-ts#12.
    if (this.subroutines instanceof DefaultSubroutineRegistry) {
      this.subroutines.wire(this.dispatcher, this.guards);
    }

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
      this.hooks.onTransitionFired?.(match, this.state);

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
      this.applyPreExecutionQuirks(match);
      executeWithLoops(
        match.actions,
        match.loops,
        this.dispatcher,
        this.guards,
        tx,
        this.state,
      );
      this.state = this.resolveNextState(match);
    } finally {
      this.currentTrigger = null;
    }
  }

  /**
   * Apply quirks that must take effect *before* a transition's actions run.
   * Currently just the figc4.6 t14 FRMR-fallback ordering fix
   * (`ax25Spec45FrmrFallbackReestablishesV20`).
   *
   * figc4.6's `FRMR received` handler (t14) draws `Establish Data Link`
   * *before* `set_version_2_0`. The dispatcher's inlined `Establish_Data_Link`
   * branches on `ctx.isExtended` (mirroring figc4.7's `mod_128` test), so while
   * the link is still extended the §975 v2.0 fallback re-establishes with a
   * *SABME* — the opposite of what a FRMR (which only a pre-v2.2 peer sends)
   * calls for. Forcing version 2.0 (`isExtended = false`) up front — before the
   * actions — makes `Establish_Data_Link` emit a *SABM*; the figure's own later
   * `set_version_2_0` action then re-applies it as a no-op. Mirrors direwolf's
   * FRMR handler, which calls `set_version_2_0` before `establish_data_link`
   * ("Erratum: Need to force v2.0. This is not in flow chart."). Scoped to the
   * `AwaitingV22Connection` `FRMR_received` transition; inert otherwise. Mirrors
   * the C# `Ax25Session.ApplyPreExecutionQuirks` (m0lte/packet.net #269).
   */
  private applyPreExecutionQuirks(match: TransitionSpec): void {
    if (
      this.context.quirks.ax25Spec45FrmrFallbackReestablishesV20 &&
      this.context.isExtended &&
      match.from === "AwaitingV22Connection" &&
      match.on === "FRMR_received"
    ) {
      this.context.isExtended = false;
    }
  }

  /**
   * Compute the state a just-committed transition advances to — normally
   * `match.next`, but with the figc4.1/figc4.2 connect-routing defect corrected
   * when `ax25Spec44Mod128ConnectRoutesToV22` is on.
   *
   * figc4.2 routes the `Disconnected` `DL_CONNECT_request`
   * (`t03_dl_connect_request`) *unconditionally* to `AwaitingConnection`, with
   * no version branch — so a v2.2-preferred connect (which the inlined
   * `Establish_Data_Link` correctly sends as a *SABME*, branching on
   * `ctx.isExtended`) ends up parked in the mod-8 establishment state. That
   * state's T1 retry resends a hardcoded SABM (downgrading the link) and it has
   * no FRMR handler (so the §975 v2.0 fallback can't fire). When the quirk is on
   * (default) and the link is extended at dispatch time, the target is rewritten
   * to `AwaitingV22Connection` (figc4.6), which resends SABME on retry and
   * handles the FRMR/DM fallbacks. See {@link Ax25SessionQuirks} for the full
   * rationale, the graphml citation, and the direwolf cross-reference.
   *
   * Scope is deliberately tight: only the exact `Disconnected` DL-CONNECT
   * transition (matched on `from` + `on` + `next`, so it survives a transition-id
   * renumber), only when `ctx.isExtended`. Every other transition is returned
   * unchanged — a mod-8 connect keeps figc4.2's `AwaitingConnection` target, and
   * the figc4.6 FRMR fallback (t14) — which forces version 2.0, clearing
   * `isExtended` — routes to `AwaitingConnection` untouched, so the redirect is
   * self-consistent with the fallback (a later connect from that mod-8 state
   * stays mod-8). Unlike the guard-rewriting quirks (ax25Spec40/42/43) this
   * rewrites a transition's *target state*. Mirrors the C#
   * `Ax25Session.ResolveNextState` (m0lte/packet.net #268).
   */
  private resolveNextState(match: TransitionSpec): string {
    if (
      this.context.quirks.ax25Spec44Mod128ConnectRoutesToV22 &&
      this.context.isExtended &&
      match.from === "Disconnected" &&
      match.on === "DL_CONNECT_request" &&
      match.next === "AwaitingConnection"
    ) {
      return "AwaitingV22Connection";
    }
    return match.next;
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
