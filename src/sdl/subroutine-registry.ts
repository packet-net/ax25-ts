import { DataLinkSubroutines, type SubroutineSpec } from "ax25sdl";
import type { TransitionContext } from "./action-dispatcher.js";
import { GuardEvaluationError, type GuardEvaluator } from "./guard-evaluator.js";
import {
  executeWithLoops,
  type SdlActionExecutor,
} from "./sdl-loop-executor.js";

/**
 * A subroutine action chain — invoked by `kind: subroutine` action steps in
 * the SDL transitions. Receives the same {@link TransitionContext} as the
 * calling chain so it can mutate session state and emit frames.
 */
export type Subroutine = (tx: TransitionContext) => void;

/**
 * Registry of figc4.7 subroutines. The dispatcher routes every
 * `kind: subroutine` verb (`Establish_Data_Link`, `Select_T1`,
 * `Enquiry_Response`, `Check_I_Frame_Acknowledged`, …) through this. The
 * {@link DefaultSubroutineRegistry} walks the figc4.7 {@link SubroutineSpec}
 * tables from `ax25sdl` once {@link DefaultSubroutineRegistry.wire | wire()}
 * has bound a dispatcher + guard evaluator; until then it no-ops.
 */
export interface SubroutineRegistry {
  invoke(name: string, tx: TransitionContext): void;
}

/**
 * Legacy subroutine names — pure name rewrites where the alias walks the
 * canonical body unchanged. Used when a YAML page calls a subroutine under a
 * name the redrawn figc4.7 doesn't emit directly. Mirrors the C#
 * `DefaultSubroutineRegistry.LegacyAliases`.
 */
const LEGACY_ALIASES: ReadonlyMap<string, string> = new Map([
  // ax25sdl names the figc4.7 subroutine `Select_T1`; earlier transcriptions
  // called it `Select_T1_Value`.
  ["Select_T1_Value", "Select_T1"],
  // figc4.7 emits `Check_Need_for_Response` (lowercase 'for'); calling pages
  // spell the verb `Check Need For Response` → `Check_Need_For_Response`.
  ["Check_Need_For_Response", "Check_Need_for_Response"],
]);

/**
 * Context-binding aliases — mutate the trigger context before walking the
 * canonical body. figc4.7b draws `Check Need for Response`'s Yes branch as
 * `Enquiry Response (F = 1)`; the `(F = 1)` annotation maps to the response
 * frame's F bit (AX.25 v2.2 §4.3: the reply to a poll sets the final bit), so
 * the alias sets {@link PendingFrame.pfBit} before the canonical
 * `Enquiry_Response` body emits its RR/RNR/SREJ. Encoding tracked at
 * m0lte/ax25sdl#45. Mirrors the C# `ContextBindingAliases`.
 */
const CONTEXT_BINDING_ALIASES: ReadonlyMap<
  string,
  { canonical: string; bind: (tx: TransitionContext) => void }
> = new Map([
  // Both the underscore-normalised and the figure-verbatim spellings route here
  // — the dispatcher invokes the subroutine with whatever the SDL emits, and
  // figc4.4's LM_SEIZE_confirm path uses the figure-spelled "Enquiry Response
  // (F = 0)" while figc4.7b's Check_Need_for_Response Yes branch uses
  // "Enquiry_Response_F_1".
  ["Enquiry_Response_F_1", { canonical: "Enquiry_Response", bind: (tx) => { tx.pending.pfBit = true; } }],
  ["Enquiry_Response_F_0", { canonical: "Enquiry_Response", bind: (tx) => { tx.pending.pfBit = false; } }],
  ["Enquiry Response (F = 1)", { canonical: "Enquiry_Response", bind: (tx) => { tx.pending.pfBit = true; } }],
  ["Enquiry Response (F = 0)", { canonical: "Enquiry_Response", bind: (tx) => { tx.pending.pfBit = false; } }],
]);

/**
 * Default registry. Pre-populates a no-op stub for every figc4.7 subroutine
 * name (plus the legacy + context-binding aliases). {@link wire} upgrades the
 * stubs to walkers that evaluate each path's guard, take the first match, and
 * execute its action chain through the dispatcher — exactly the C#
 * `DefaultSubroutineRegistry` behaviour. Until `wire()` runs (or for a name a
 * caller has {@link register}ed), invocation is a no-op / the override.
 */
export class DefaultSubroutineRegistry implements SubroutineRegistry {
  private readonly subroutines = new Map<string, Subroutine>();
  private readonly userOverridden = new Set<string>();
  private readonly specs: readonly SubroutineSpec[];
  private wiredDispatcher: SdlActionExecutor | null = null;
  private wiredGuards: GuardEvaluator | null = null;

  constructor(
    private readonly onUnknown: (name: string) => void = () => {},
    specs: readonly SubroutineSpec[] = DataLinkSubroutines.subroutines,
  ) {
    this.specs = specs;
    const noop: Subroutine = () => {
      /* no-op until wire() is called */
    };
    for (const spec of specs) this.subroutines.set(spec.name, noop);
    for (const alias of LEGACY_ALIASES.keys()) this.subroutines.set(alias, noop);
    for (const alias of CONTEXT_BINDING_ALIASES.keys()) this.subroutines.set(alias, noop);
  }

  /** Register a custom handler for a named subroutine (sticky — a later
   * {@link wire} won't replace it). Replaces any prior entry. */
  register(name: string, impl: Subroutine): void {
    this.subroutines.set(name, impl);
    this.userOverridden.add(name);
  }

  /**
   * Bind a dispatcher + guard evaluator. Every spec name (and alias) not
   * previously {@link register}ed is replaced with a walker over its figc4.7
   * paths. Order-independent w.r.t. {@link register}.
   */
  wire(dispatcher: SdlActionExecutor, guards: GuardEvaluator): void {
    this.wiredDispatcher = dispatcher;
    this.wiredGuards = guards;
    const specsByName = new Map(this.specs.map((s) => [s.name, s]));
    for (const spec of this.specs) {
      if (this.userOverridden.has(spec.name)) continue;
      this.subroutines.set(spec.name, (tx) => this.walkSubroutine(spec, tx));
    }
    for (const [alias, canonicalName] of LEGACY_ALIASES) {
      if (this.userOverridden.has(alias)) continue;
      const spec = specsByName.get(canonicalName);
      if (spec) this.subroutines.set(alias, (tx) => this.walkSubroutine(spec, tx));
    }
    for (const [alias, { canonical, bind }] of CONTEXT_BINDING_ALIASES) {
      if (this.userOverridden.has(alias)) continue;
      const spec = specsByName.get(canonical);
      if (spec) {
        this.subroutines.set(alias, (tx) => {
          bind(tx);
          this.walkSubroutine(spec, tx);
        });
      }
    }
  }

  invoke(name: string, tx: TransitionContext): void {
    const impl = this.subroutines.get(name);
    if (impl) {
      impl(tx);
      return;
    }
    this.onUnknown(name);
  }

  private walkSubroutine(spec: SubroutineSpec, tx: TransitionContext): void {
    // wire() must have run before the walker fires; if not, no-op silently
    // (matches the pre-figc4.7 behaviour).
    if (this.wiredDispatcher == null || this.wiredGuards == null) return;
    for (const path of spec.paths) {
      let guardHolds: boolean;
      try {
        guardHolds = this.wiredGuards.evaluate(path.guard);
      } catch (e) {
        // Predicate not bound yet — treat the path as not-matching so the
        // subroutine degrades to no-op rather than crashing the calling
        // transition. Mirrors the C# walker's GuardEvaluationException catch.
        if (e instanceof GuardEvaluationError) continue;
        throw e;
      }
      if (!guardHolds) continue;
      executeWithLoops(
        path.actions,
        path.loops,
        this.wiredDispatcher,
        this.wiredGuards,
        tx,
        `subroutine:${spec.name}`,
      );
      return;
    }
    // No matching path — silently no-op.
  }
}
