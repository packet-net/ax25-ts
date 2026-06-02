import type { ActionStep, LoopRange } from "ax25sdl";
import type { GuardEvaluator } from "./guard-evaluator.js";
import type { TransitionContext } from "./action-dispatcher.js";

/**
 * Minimal structural view of the action dispatcher the loop executor needs.
 * Declared here (rather than importing the concrete {@link ActionDispatcher})
 * so this module stays free of the action-dispatcher → subroutine-registry →
 * loop-executor import cycle. {@link ActionDispatcher} satisfies it.
 */
export interface SdlActionExecutor {
  execute(
    steps: readonly ActionStep[],
    tx: TransitionContext,
    currentState: string,
  ): void;
}

// Bound: the legitimate maximum is the send window (k ≤ 128); beyond this the
// loop body isn't advancing the state its predicate reads — fail loudly rather
// than spin.
const MAX_LOOP_ITERATIONS = 1024;

/**
 * Execute an SDL action chain, expanding any SDL loops (`loop_while`, from
 * ax25sdl 0.7.0+). Each {@link LoopRange} marks a body slice over the flat
 * `actions` list that re-runs while its continue predicate holds. Loops are
 * non-overlapping and non-nested. A head-test (`while`) loop checks the
 * predicate before each iteration (zero-or-more runs); a tail-test (`do-while`,
 * `testAtEnd`) after (one-or-more). Mirrors the C# `SdlLoopExecutor`, and is
 * shared by the transition driver ({@link SdlSessionDriver}) and the figc4.7
 * subroutine walker ({@link DefaultSubroutineRegistry}).
 */
export function executeWithLoops(
  actions: readonly ActionStep[],
  loops: readonly LoopRange[],
  dispatcher: SdlActionExecutor,
  guards: GuardEvaluator,
  tx: TransitionContext,
  stateLabel: string,
): void {
  if (loops.length === 0) {
    dispatcher.execute(actions, tx, stateLabel);
    return;
  }
  const ordered = [...loops].sort((a, b) => a.start - b.start);
  let idx = 0;
  for (const loop of ordered) {
    if (idx < loop.start) {
      dispatcher.execute(actions.slice(idx, loop.start), tx, stateLabel);
    }
    runLoop(loop, actions, dispatcher, guards, tx, stateLabel);
    idx = loop.start + loop.length;
  }
  if (idx < actions.length) {
    dispatcher.execute(actions.slice(idx), tx, stateLabel);
  }
}

function runLoop(
  loop: LoopRange,
  actions: readonly ActionStep[],
  dispatcher: SdlActionExecutor,
  guards: GuardEvaluator,
  tx: TransitionContext,
  stateLabel: string,
): void {
  const body = actions.slice(loop.start, loop.start + loop.length);
  let iterations = 0;
  const shouldContinue = (): boolean => guards.evaluate(loop.predicate);
  const runBody = (): void => {
    dispatcher.execute(body, tx, stateLabel);
    if (++iterations > MAX_LOOP_ITERATIONS) {
      throw new Error(
        `SDL loop (predicate '${loop.predicate}') exceeded ${MAX_LOOP_ITERATIONS} ` +
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
