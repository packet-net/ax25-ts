/**
 * Loss-recovery conformance — the TypeScript port of packet.net's
 * `LossRecoveryProperties` (`tests/Packet.Ax25.Tests/Session/Conformance/`).
 * Adversarial generative testing over the {@link TwoStationHarness}: a loss
 * pattern is generated, the run is driven over a lossy in-process link, and the
 * {@link InvariantChecker} oracle judges convergence. A failure is a
 * reproducible counterexample (the seed prints in the test name).
 *
 * ## Property-testing approach — seeded parametrized loops (no fast-check)
 *
 * packet.net uses FsCheck (`[Property(MaxTest = …)]`, generating `seedN`,
 * `seedDrop`, `srej`, …). ax25-ts has no property-testing library on its
 * dependency tree (checked `package.json` — no `fast-check`), and this suite
 * may only touch files under `tests/conformance/`, so adding one is out of
 * scope. We reproduce FsCheck's coverage with deterministic parametrized
 * `it`-loops over an enumerated seed space — the same `seedN`/`seedDrop`/`srej`
 * tuples FsCheck would draw, swept exhaustively over the small bounded ranges
 * (n ∈ 1..6, dropPos ∈ 0..n-1, both REJ and SREJ). Each case is its own `it`,
 * so a failure names the exact seed and the run stays a pure function of it —
 * the determinism FsCheck shrinking would rely on, without the dependency.
 *
 * ## What runs vs. what is pending the recovery runtime
 *
 * The harness loss *infrastructure* (drop filter + `advanceT1`) is exercised
 * and self-verified here unconditionally. The single-frame **SREJ** selective
 * recovery (figc4.4 `Push Old I Frame N(r) on Queue`) also works today and is
 * tested end-to-end — via a directly-delivered SREJ trigger, because the
 * wire-level SREJ frame is still REJ-on-the-wire in this port (no SREJ factory
 * yet — `frame.ts` classify() treats SREJ as out of scope) and the figc4.5/4.7
 * timeout-driven go-back-N (`Transmit_Enquiry` → `Invoke_Retransmission`) does
 * not yet emit a retransmit. The DEEP recovery properties — timeout-driven
 * go-back-N reached purely by `advanceT1()`, multi-frame bursts, and the SREJ
 * recovery quirks (`Ax25Spec40/41/42`) — are written faithfully to the
 * packet.net reference but `.skip`ped pending that runtime PR; see each note.
 */
import { describe, expect, it } from "vitest";
import { classify, getNs, rej, type Ax25Frame } from "../../src/frame.js";
import {
  type Endpoint,
  iFrameFrom,
  TwoStationHarness,
} from "./two-station-harness.js";

/** Non-negative modulo, overflow-safe — the TS port of packet.net's `Mod`. */
function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** A one-shot drop latch: drops the first frame matching `match`, then never
 * again (the channel is clean once the single drop is consumed). Mirrors the
 * `dropped` flag in packet.net's single-drop property. */
function dropOnce(match: (f: Ax25Frame) => boolean): (f: Ax25Frame) => boolean {
  let done = false;
  return (f) => {
    if (done) return false;
    if (!match(f)) return false;
    done = true;
    return true;
  };
}

/**
 * The figc4.4 SREJ trigger as a directly-delivered event carrying the peer's
 * N(R). The dispatcher reads only N(R) (via `getNr`), so a REJ-shaped frame
 * with that N(R) is a faithful stand-in — there is no public SREJ wire factory
 * yet (the dispatcher's `SREJ` verb itself falls back to REJ on the wire).
 * Mirrors `srejEvent` in `tests/DataLinkSrejUnderLoss.test.ts` and
 * `SessionQuirks.test.ts`.
 */
function deliverSrej(to: Endpoint, nr: number): void {
  const frame: Ax25Frame = rej({
    destination: to.context.local,
    source: to.context.remote,
    nr,
    isCommand: false,
    pollFinal: true,
  });
  to.driver.postEvent({ name: "SREJ_received", frame });
}

// ─── Harness loss infrastructure (self-verified — runs today) ──────────────

describe("loss-recovery — harness infrastructure", () => {
  it("the drop filter drops exactly the targeted I-frame (and still logs it)", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false; // a dropped frame is an intentional gap

    // Drop A's I-frame N(s)=0, once.
    h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
    h.submit(h.a, 0xa0);

    // It was put on the wire (logged) but never delivered to B.
    const i0OnWire = h.link.log.filter(
      (f) => classify(f) === "I" && getNs(f) === 0,
    );
    expect(i0OnWire.length).toBe(1); // A transmitted it…
    expect(h.b.delivered.length).toBe(0); // …but the link swallowed it.
  });

  it("a frame NOT matched by the drop filter is delivered normally", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    // Filter targets N(s)=5, which never occurs in a single submit → no drop.
    h.dropWhen(iFrameFrom(h.a, 5));
    h.submit(h.a, 0xc7);
    expect(h.b.delivered.map((d) => d[0])).toEqual([0xc7]);
    h.assertConverged();
  });

  it("advanceT1() fires the live T1 timeout — Connected drops to TimerRecovery", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false;

    // Swallow A's only I-frame so its ack never comes back; T1 is now the only
    // thing that can fire.
    h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
    h.submit(h.a, 0xa0);
    expect(h.scheduler.isRunning("T1")).toBe(true); // T1 armed, awaiting ack
    expect(h.a.state).toBe("Connected");

    // Crossing T1 must fire the timeout: figc4.x takes Connected → TimerRecovery
    // on T1-expiry. (The retransmit that TimerRecovery should then send is the
    // runtime still being built — see the skipped properties below — but the
    // timeout itself firing is what advanceT1 guarantees, and is the hook the
    // recovery properties hang on.)
    h.advanceT1();
    expect(h.a.state).toBe("TimerRecovery");
  });

  it("recoverUntilConverged returns true immediately on an already-clean link", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.submit(h.a, 0x01);
    // No loss → already converged; the loop should not need a single round.
    expect(h.converged()).toBe(true);
    expect(h.recoverUntilConverged(40)).toBe(true);
  });
});

// ─── Single dropped I-frame — SREJ selective recovery (runs today) ─────────
//
// This is packet.net's `A_single_dropped_iframe_always_recovers` restricted to
// the path the current ax25-ts runtime supports end-to-end: SREJ-mode selective
// retransmit of a single dropped frame. The figc4.4 `Push Old I Frame N(r) on
// Queue` verb is live and preserves the original N(s) (M0LTE/ax25-ts#8 /
// packet.net#231). Because the SREJ is REJ-on-the-wire in this port, we deliver
// the SREJ trigger to the sender directly (its peer's intent — it is missing
// N(r)), exactly as `DataLinkSrejUnderLoss.test.ts` does. The dropped frame is
// recovered selectively, the held out-of-sequence frame is retrieved, and both
// payloads are delivered in order — full convergence.

describe("loss-recovery — single dropped I-frame recovers (SREJ, selective)", () => {
  // Two distinct submit-byte patterns × dropping the first frame: a small
  // deterministic sweep standing in for the FsCheck `seedDrop` draw over the
  // converging shape this runtime already supports.
  for (const payloads of [
    [0xa0, 0xa1],
    [0x11, 0x22],
  ]) {
    it(`drop N(s)=0 then SREJ(0) recovers [${payloads.map((b) => b.toString(16)).join(",")}]`, () => {
      const h = TwoStationHarness.build({ srej: true, k: 4 });
      h.connect();
      h.checkAfterEachStep = false;

      // Drop A's frame 0 once; frame 1 arrives out of sequence and B holds it.
      h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
      for (const b of payloads) h.submit(h.a, b);

      // B is missing N(r)=0 → deliver the SREJ trigger to A. A selectively
      // retransmits frame 0 with its ORIGINAL N(s); B fills the gap, retrieves
      // the stored frame 1, and delivers both in order.
      deliverSrej(h.a, 0);
      h.settle();

      expect(h.b.delivered.map((d) => d[0])).toEqual(payloads);
      expect(h.a.context.vs).toBe(payloads.length); // no renumbering (#231)
      h.assertConverged();
    });
  }
});

// ─── Deep recovery properties — PENDING the recovery runtime ───────────────
//
// Ported faithfully from packet.net's `LossRecoveryProperties`, but skipped:
// they need the timeout-driven go-back-N runtime (figc4.5/4.7
// `Transmit_Enquiry` → `Invoke_Retransmission` actually emitting a retransmit)
// and the SREJ recovery quirks `Ax25Spec40/41/42`, which a parallel PR is
// implementing. Verified empirically against the current runtime: `advanceT1()`
// fires the T1 timeout and parks the sender in TimerRecovery, but no retransmit
// reaches the wire, so none of these converge yet.

describe("loss-recovery — deep recovery properties (pending recovery runtime)", () => {
  // FsCheck seed space, swept exhaustively over the bounded ranges the C#
  // `[Property]` draws: n ∈ 1..6 I-frames, dropPos ∈ 0..n-1, both REJ and SREJ.
  const singleDropSeeds: { n: number; dropPos: number; srej: boolean }[] = [];
  for (let seedN = 0; seedN < 6; seedN++) {
    const n = 1 + seedN; // 1..6
    for (let dropPos = 0; dropPos < n; dropPos++) {
      for (const srej of [false, true]) {
        singleDropSeeds.push({ n, dropPos, srej });
      }
    }
  }

  // Port of `A_single_dropped_iframe_always_recovers` — but reaching recovery
  // purely through `advanceT1()` (no injected SREJ): connect, submit n frames,
  // drop the one with N(s)=dropPos once, then drive T1 recovery until the link
  // converges. Today the timeout-driven retransmit is a no-op so this can't
  // converge for either mode.
  for (const { n, dropPos, srej } of singleDropSeeds) {
    const mode = srej ? "SREJ" : "REJ";
    it.skip(
      `single dropped I-frame always recovers [n=${n} drop=N(s)${dropPos} ${mode}]`,
      () => {
        // un-skip after the recovery-runtime PR (Invoke_Retransmission verbs +
        // Ax25Spec40/41/42) lands — verifies timeout-driven go-back-N (and SREJ
        // selective) recovery of any single dropped I-frame, reached purely via
        // advanceT1(), converges (windows empty + complete in-order delivery).
        const k = Math.max(4, n);
        const h = TwoStationHarness.build({ srej, k });
        h.connect();
        h.checkAfterEachStep = false;

        h.dropWhen(dropOnce(iFrameFrom(h.a, dropPos)));
        for (let i = 0; i < n; i++) h.submit(h.a, i);

        // Channel is clean once the single drop is consumed; drive T1 recovery
        // until convergence (bounded — non-convergence is the bug we hunt).
        h.recoverUntilConverged(40);
        h.assertConverged();
      },
    );
  }

  // Port of `A_finite_bidirectional_loss_burst_recovers`. A finite budget of
  // drops in EITHER direction (lost I-frames, acks, retransmits), then the
  // channel clears; recovery must complete on the clean tail. Needs the full
  // recovery runtime + the SREJ quirks (the C# comment cites #242/#241/#246 for
  // the SREJ sweep). Seeds sweep n, budget, a pattern RNG seed, and both modes.
  const burstSeeds: {
    n: number;
    budget: number;
    pattern: number;
    srej: boolean;
  }[] = [];
  for (let seedN = 0; seedN < 6; seedN++) {
    const n = 1 + seedN; // 1..6
    for (let seedBudget = 0; seedBudget <= n; seedBudget++) {
      const budget = mod(seedBudget, n + 1); // 0..n total drops — finite
      for (const pattern of [1, 2, 7]) {
        for (const srej of [false, true]) {
          burstSeeds.push({ n, budget, pattern, srej });
        }
      }
    }
  }

  for (const { n, budget, pattern, srej } of burstSeeds) {
    const mode = srej ? "SREJ" : "REJ";
    it.skip(
      `finite bidirectional loss burst recovers [n=${n} budget=${budget} pat=${pattern} ${mode}]`,
      () => {
        // un-skip after the recovery-runtime PR (Invoke_Retransmission verbs +
        // Ax25Spec40/41/42) lands — verifies that after up to `budget` frames
        // are dropped in either direction and the channel then clears, the link
        // recovers to full convergence.
        const k = Math.max(4, n);
        // N2 generous so the link doesn't give up before the finite loss clears.
        const h = TwoStationHarness.build({ srej, k, n2: 40 });
        h.connect();
        h.checkAfterEachStep = false;

        // Deterministic LCG so the drop pattern is a pure function of `pattern`
        // (no Math.random — the run must be replayable, like the C# `Random`).
        let state = pattern >>> 0;
        const next = (): number => {
          state = (state * 1664525 + 1013904223) >>> 0;
          return state / 0x100000000;
        };
        let dropsLeft = budget;
        h.dropWhen(() => {
          if (dropsLeft > 0 && next() < 0.5) {
            dropsLeft--;
            return true;
          }
          return false;
        });

        for (let i = 0; i < n; i++) h.submit(h.a, i);
        h.recoverUntilConverged(80);
        h.assertConverged();
      },
    );
  }

  // Regression for the ax25spec#40 SREJ livelock (packet.net#242): a multi-frame
  // bidirectional SREJ burst used to spin to the pump's 256-round bound (B SREJ'd
  // out-of-window duplicates, A re-sent, repeat). With Ax25Spec40 (window guard)
  // on, B discards out-of-window frames instead, so a moderate SREJ burst
  // converges. Port of `Srej_bidirectional_loss_burst_recovers_with_window_guard`.
  it.skip(
    "SREJ bidirectional loss burst recovers with window guard (ax25spec#40 / #242)",
    () => {
      // un-skip after the recovery-runtime PR (Invoke_Retransmission verbs +
      // Ax25Spec40/41/42) lands — verifies the Ax25Spec40 out-of-window discard
      // breaks the duplicate-SREJ livelock so a moderate SREJ burst converges.
      const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
      h.connect();
      h.checkAfterEachStep = false;
      let state = 2;
      const next = (): number => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
      let dropsLeft = 2;
      h.dropWhen(() => {
        if (dropsLeft > 0 && next() < 0.5) {
          dropsLeft--;
          return true;
        }
        return false;
      });
      for (let i = 0; i < 6; i++) h.submit(h.a, i);
      h.recoverUntilConverged(60);
      h.assertConverged();
    },
  );

  // Convergence regression for the full SREJ recovery stack (packet.net#241/#242/
  // #246): a heavy burst needs the window guard (Ax25Spec40), the SRT overflow
  // guard (Ax25Spec41), and Ax25Spec42 (SREJ targets the gap V(R), not the
  // just-arrived frame). Port of `Srej_heavy_bidirectional_loss_burst_recovers`.
  it.skip(
    "SREJ heavy bidirectional loss burst recovers (ax25spec#40/#41/#42)",
    () => {
      // un-skip after the recovery-runtime PR (Invoke_Retransmission verbs +
      // Ax25Spec40/41/42) lands — verifies all three SREJ quirks together let a
      // heavy multi-frame selective-reject burst converge.
      const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
      h.connect();
      h.checkAfterEachStep = false;
      let state = 2;
      const next = (): number => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
      let dropsLeft = 5;
      h.dropWhen(() => {
        if (dropsLeft > 0 && next() < 0.5) {
          dropsLeft--;
          return true;
        }
        return false;
      });
      for (let i = 0; i < 6; i++) h.submit(h.a, i);
      h.recoverUntilConverged(60);
      h.assertConverged();
    },
  );
});
