/**
 * Property: loss-recovery / stream invariant, driven generatively. Over a
 * connected session subjected to a *random finite* drop pattern, the delivered
 * upper-layer stream equals the sent stream, in order — the headline AX.25
 * connected-mode guarantee (reliable, in-order, gap-free, duplicate-free
 * delivery). The fast-check generalisation of the seeded parametrized-loop
 * sweeps in `tests/conformance/loss-recovery.test.ts` and
 * `tests/conformance/mod128-loss-recovery.test.ts`, and the TS analogue of
 * packet.net's FsCheck `LossRecoveryProperties`
 * (`A_single_dropped_iframe_always_recovers` /
 * `A_finite_bidirectional_loss_burst_recovers`).
 *
 * The existing conformance suite explicitly noted it could *not* use a property
 * library — "ax25-ts has no property-testing library on its dependency tree …
 * adding one is out of scope" (that file may only touch `tests/conformance/`).
 * This file closes that gap: same harness, same oracle, now fed by fast-check
 * generators instead of an enumerated seed space, so the loss space is sampled
 * (and shrunk on failure) rather than hand-listed.
 *
 * ## Scope: unidirectional data transfer + ring-wrap regime
 *
 * The single-drop and finite-loss properties below drive data in ONE direction
 * (A → B) under a lossy channel, matching exactly what the C#
 * `LossRecoveryProperties` exercise: there "bidirectional" names bidirectional
 * *drops* (acks/retransmits in either direction), not bidirectional *data
 * submission* — every C# loss property submits from A only (`for (i…)
 * h.Submit(h.A, i)`).
 *
 * The "sequence-ring-wrap recovery" block (added with the M0LTE/packet.net#285
 * mirror) lifts the n cap into the n ≥ 8 regime where V(S) wraps the mod-8 ring
 * mid-recovery — the regime that surfaced the SREJ ring-wrap duplicate. It uses
 * {@link TwoStationHarness.submitBurst} (frames in flight together) and includes
 * BIDIRECTIONAL *wrapping* bursts (both stations burst ≥ k frames simultaneously),
 * mirroring the C# `Wrapping_burst_with_one_drop_recovers` and
 * `Bidirectional_wrapping_bursts_recover` properties. A residual LOW-n
 * simultaneous-bidirectional duplicate (k = 4, far below the ring boundary) is a
 * separate, distinct defect — confirmed present in the C# reference too, and out
 * of scope for the #285 mirror — pinned in
 * `srej-recovery-duplicate-delivery.known-failure.test.ts`.
 *
 * ## Why finite loss
 *
 * Recovery is only *guaranteed* to converge once the disruption ceases (within
 * N2 retries). An unbounded-loss channel is the N2-give-up path, not the
 * reliable-delivery path — so, exactly as the C# `…_finite_…` property does, the
 * generators bound the drop budget and then let the clean tail reconverge. The
 * oracle (`assertConverged` → `checkReliableDelivery`) is the invariant; a
 * `withStormCap`-style wire ceiling turns any non-convergence into a fast,
 * attributable failure rather than a hang.
 *
 * ## Window-size precondition (k ≤ modulus − 1)
 *
 * AX.25 (inheriting X.25 §2.3.2.3) requires the send window k ≤ N − 1 (≤ 7 for
 * mod-8, ≤ 127 for mod-128): with k = N, a full window of outstanding frames
 * makes `(V(s) − V(a)) mod N` wrap to 0, indistinguishable from an empty window.
 * The generators cap k accordingly; `k = N` is a misconfiguration, not a loss
 * scenario, and is out of scope here.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type Ax25Frame, classify, getNs } from "../../src/frame.js";
import { defaultSessionQuirks } from "../../src/sdl/session-quirks.js";
import {
  type Endpoint,
  TwoStationHarness,
  iFrameFrom,
} from "../conformance/two-station-harness.js";

const RUNS = 300; // each run drives a full multi-frame recovery — keep modest

/** Hard ceiling on frames-on-wire per run — a converging scenario settles well
 * under this; tripping it means a storm, so fail fast and loud rather than
 * spinning the synchronous pump. Mirrors `WIRE_STORM_CAP` in the conformance
 * loss-recovery suite. */
const WIRE_STORM_CAP = 6000;

function withStormCap(
  log: readonly unknown[],
  predicate: (f: Ax25Frame) => boolean,
): (f: Ax25Frame) => boolean {
  return (f) => {
    if (log.length > WIRE_STORM_CAP) {
      throw new Error(
        `storm: wire exceeded ${WIRE_STORM_CAP} frames without converging`,
      );
    }
    return predicate(f);
  };
}

/** Deterministic LCG → [0,1). The drop pattern is a pure function of its seed,
 * so a failing case replays exactly (no Math.random). Mirrors the conformance
 * suite's `lcg`. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** k capped to the modulo's legal window (N − 1). */
function legalWindow(want: number, extended: boolean): number {
  return Math.min(want, extended ? 127 : 7);
}

/** The flattened delivered byte-stream at `e` (one byte per single-byte
 * submission — the harness submits single-byte payloads). */
function deliveredStream(e: Endpoint): number[] {
  return e.delivered.map((d) => d[0]!);
}

/** The flattened submitted byte-stream at `e`. */
function submittedStream(e: Endpoint): number[] {
  return e.submitted.map((d) => d[0]!);
}

/** A finite drop filter from an LCG seed + budget: drops frames in either
 * direction until the budget is spent, then the channel is clean. Byte-identical
 * to the C# `FiniteDrops` and the conformance suite's `finiteDrops`, so a seeded
 * drop pattern replays the exact same way across runtimes. */
function finiteDrops(seed: number, budget: number): () => boolean {
  const next = lcg(seed);
  let left = budget;
  return () => {
    if (left > 0 && next() < 0.5) {
      left--;
      return true;
    }
    return false;
  };
}

/** Submit `payloadsA` from A and `payloadsB` from B interleaved, before any
 * settle, so both transfers (and their recoveries) are in flight together on the
 * shared pump — the SIMULTANEOUS-bidirectional regime neither per-frame
 * {@link TwoStationHarness.submit} (pumps after each frame) nor
 * {@link TwoStationHarness.submitBurst} (one direction) reaches. Mirrors the C#
 * `SubmitSimultaneous`. */
function submitSimultaneous(
  h: TwoStationHarness,
  payloadsA: number[],
  payloadsB: number[],
): void {
  const n = Math.max(payloadsA.length, payloadsB.length);
  for (let i = 0; i < n; i++) {
    if (i < payloadsA.length) {
      const a = Uint8Array.from([payloadsA[i]! & 0xff]);
      h.a.submitted.push(a);
      h.a.driver.postEvent({ name: "DL_DATA_request", data: a, pid: 0xf0 });
    }
    if (i < payloadsB.length) {
      const b = Uint8Array.from([payloadsB[i]! & 0xff]);
      h.b.submitted.push(b);
      h.b.driver.postEvent({ name: "DL_DATA_request", data: b, pid: 0xf0 });
    }
  }
}

describe("property: single dropped I-frame always recovers (delivered == sent, in order)", () => {
  // Mirrors `A_single_dropped_iframe_always_recovers`, fuzzed over n, the
  // dropped position, REJ/SREJ, and both modulos.
  it("over any (n, dropPos, mode, modulo)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.boolean(), // srej
        fc.boolean(), // extended (mod-8 / mod-128)
        fc.nat(),
        (n, srej, extended, dropSeed) => {
          const dropPos = dropSeed % n; // 0..n-1
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 40 });
          h.connect();
          h.checkAfterEachStep = false;

          // Drop A's I-frame with N(S)=dropPos exactly once (mode-aware N(S)).
          let dropped = false;
          h.dropWhen(
            withStormCap(h.link.log, (f) => {
              if (dropped) return false;
              if (!iFrameFrom(h.a, dropPos)(f)) return false;
              dropped = true;
              return true;
            }),
          );

          // Distinct payloads (1..n) so any reorder/dup is observable.
          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);

          expect(h.recoverUntilConverged(60)).toBe(true);
          // The stream invariant, stated directly: delivered == sent, in order.
          expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
          h.assertConverged(); // + full safety/window re-check
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("property: finite loss burst recovers (delivered == sent, in order)", () => {
  // Mirrors `A_finite_bidirectional_loss_burst_recovers`: a finite drop budget
  // in EITHER direction (I-frames, acks, retransmits all eligible), then the
  // channel clears and the clean tail must reconverge. Fuzzed over n, budget,
  // the pattern seed, mode, and modulo. Data flows A → B (as in the C# property).
  // n stays ≤ 7 here because per-frame submit() serialises the transfer (it pumps
  // to quiescence after each frame), so even at n = 8 the ring never wraps
  // mid-recovery. The n ≥ 8 ring-wrap regime — where V(S) wraps the mod-8 ring
  // with frames in flight together — is covered by the "sequence-ring-wrap
  // recovery" block below (submitBurst), where the SREJ ring-wrap duplicate used
  // to bite and is now fixed (M0LTE/packet.net#285).
  it("A → B under a finite bidirectional-drop budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 1 << 20 }),
        fc.nat(),
        (n, srej, extended, patternSeed, budgetSeed) => {
          const budget = budgetSeed % (n + 1); // 0..n total drops — finite
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 60 });
          h.connect();
          h.checkAfterEachStep = false;

          const next = lcg(patternSeed);
          let dropsLeft = budget;
          h.dropWhen(
            withStormCap(h.link.log, () => {
              if (dropsLeft > 0 && next() < 0.5) {
                dropsLeft--;
                return true;
              }
              return false;
            }),
          );

          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);
          expect(h.recoverUntilConverged(120)).toBe(true);
          expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
          h.assertConverged();
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ─── SIMULTANEOUS bidirectional SREJ recovery (figc4.5 drain fix, #286) ──────
//
// The defects this block guards surfaced when porting the #285 mod-8 ring-wrap
// fix to TS, under SIMULTANEOUS bidirectional data — each station concurrently a
// sender-in-recovery AND a receiver under SREJ — a regime the unidirectional
// properties above never reach (every loss case above submits from A only). Both
// were root-caused to a single figure defect: figc4.5 (Timer Recovery) drew its
// stored-frame drain loop with `V(r) := V(r) - 1` where figc4.4 (Connected) uses
// `V(r) := V(r) + 1`. The decrement left V(R) under-advanced through the drain, so
// a station recovering an SREJ gap while in Timer Recovery re-delivered the peer's
// next genuine retransmit and the link failed to converge. Fixed by the default-on
// `ax25Spec47TimerRecoveryDrainAdvancesVR` quirk (packethacking/ax25spec#47,
// m0lte/packet.net#286), which rewrites the drain verb to advance V(R). These were
// previously pinned (red-when-fixed) in
// `srej-recovery-duplicate-delivery.known-failure.test.ts`; that file is removed
// and its cases folded here, now passing. Mirrors the C#
// `BidirectionalSrejRecoveryTests`.
describe("property: simultaneous bidirectional SREJ recovery (figc4.5 drain fix)", () => {
  // R1 minimal repro, the exact ax25-ts case-1 shape: mod-8 SREJ, k=4, A submits
  // one payload while B submits two, finite LCG(1) drop budget 3. Before the fix A
  // delivered B's two-frame stream twice ([0x80,0x81,0x80,0x81]) and the link never
  // reconverged; with the figc4.5-drain quirk on (default) each stream is delivered
  // exactly once and the link converges. (Reproduced identically on the C#
  // reference post-#285 — a shared defect, fixed in both runtimes.) Mirrors the C#
  // `Bidirectional_mod8_srej_lowN_delivers_each_stream_once`.
  it("R1: mod-8 SREJ k=4 nA=1 nB=2 (LCG 1, budget 3) — each stream delivered once, link converges", () => {
    const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80 });
    h.connect();
    h.checkAfterEachStep = false; // both directions' frames queue before settling
    h.dropWhen(finiteDrops(1, 3));

    h.submit(h.a, 0x01);
    h.submit(h.b, 0x80);
    h.submit(h.b, 0x81);
    expect(h.recoverUntilConverged(160)).toBe(true);

    expect(deliveredStream(h.a)).toEqual([0x80, 0x81]);
    expect(deliveredStream(h.b)).toEqual([0x01]);
    h.assertConverged();
  });

  // Quirk-isolation tripwire: with ONLY ax25Spec47TimerRecoveryDrainAdvancesVR off
  // (every other correction still on), the same scenario reproduces the figc4.5
  // drain defect exactly — A delivers B's stream twice and the link does not
  // converge. This proves the figc4.5 decrement is the SOLE cause of R1 (not some
  // other quirk) and that the default-on quirk is what closes it. If this stops
  // reproducing, the figure has likely been corrected upstream and the quirk can be
  // retired. Mirrors the C#
  // `Bidirectional_mod8_srej_lowN_reproduces_defect_with_only_spec47_off`.
  it("R1 isolation: with only ax25Spec47 off, the figc4.5 drain defect reproduces ([0x80,0x81,0x80,0x81], no convergence)", () => {
    const quirks = {
      ...defaultSessionQuirks,
      ax25Spec47TimerRecoveryDrainAdvancesVR: false,
    };
    const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80, quirks });
    h.connect();
    h.checkAfterEachStep = false;
    h.dropWhen(finiteDrops(1, 3));

    h.submit(h.a, 0x01);
    h.submit(h.b, 0x80);
    h.submit(h.b, 0x81);
    h.recoverUntilConverged(160);

    // The faithful-decrement defect: B's two payloads delivered to A twice, and the
    // link never reconverges (V(R) was left under-advanced).
    expect(deliveredStream(h.a)).toEqual([0x80, 0x81, 0x80, 0x81]);
    expect(h.converged()).toBe(false);
  });

  // Generative sweep of the simultaneous-bidirectional low-n SREJ regime (the
  // broader R1 class), at BOTH modulos and BOTH reject schemes: A and B each submit
  // 1..k frames at once under a finite LCG drop budget, then the channel clears.
  // Both directions must recover to exactly-once in-order delivery and converge.
  // This is the two-way analogue of the A-only finite-loss property above — the gap
  // that hid R1. Mirrors the C# `Simultaneous_bidirectional_lowN_srej_recovers`
  // (MaxTest = 400).
  it("R1 sweep: A↔B each submit 1..k simultaneously under finite loss and recover (both modulos, REJ+SREJ)", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 1, max: 1 << 20 }),
        fc.boolean(), // extended (mod-8 / mod-128)
        fc.boolean(), // srej
        (seedNa, seedNb, seedBudget, patternSeed, extended, srej) => {
          const k = extended ? 16 : 7;
          const na = 1 + (seedNa % k);
          const nb = 1 + (seedNb % k);
          const budget = seedBudget % (na + nb + 1); // finite ⇒ the channel always clears

          const h = TwoStationHarness.build({ srej, k, extended, n2: 80 });
          h.connect();
          h.checkAfterEachStep = false;
          h.dropWhen(withStormCap(h.link.log, finiteDrops(patternSeed, budget)));

          const a = Array.from({ length: na }, (_, i) => (0x10 + i) & 0xff);
          const b = Array.from({ length: nb }, (_, i) => (0x80 + i) & 0xff);
          submitSimultaneous(h, a, b);
          h.settle();
          expect(h.recoverUntilConverged(200)).toBe(true);

          // Exactly-once in-order delivery, both ways, + empty windows.
          expect(deliveredStream(h.b)).toEqual(a);
          expect(deliveredStream(h.a)).toEqual(b);
          h.assertConverged();
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ─── n ≥ 8 sequence-ring-wrap recovery (the mod-8 SREJ data-integrity bug) ──
//
// The properties above cap n at 1..7 from a single station and settle after
// every per-frame submit, so N(S) never wraps the 0–7 ring mid-recovery. That
// hid a data-integrity bug: under mod-8 SREJ, a bulk transfer of ≥ 8 frames
// flying together (so V(S) wraps 7→0) plus a loss pattern made the receiver
// re-deliver already-delivered frames and desync permanently. Reference repro
// (mod-8 SREJ, k=7, 8 frames): a single drop yielded delivered [1..8, 1, 2] —
// frames 1 and 2 delivered twice. Root cause: the recovery path replayed
// I-frames from the sent-frame store even after they were acknowledged; once
// V(R) wrapped past those numbers, the receiver took the stale retransmits for
// new data. Fixed by gating selective replay on the live send window [V(a),
// V(s)) and to once-per-recovery-cycle, and pruning the sent-frame store on
// acknowledgement (src/sdl/action-dispatcher.ts + session-context.ts). These
// pin the fix and guard the regression. Mirrors the C# `LossRecoveryProperties`
// ring-wrap additions (M0LTE/packet.net#285).

/** Drop the `target`-th distinct I-frame `from` puts on the wire (by emission
 * order, NOT by N(S), since N(S) repeats across the wrap), exactly once. The
 * stateful analogue of {@link iFrameFrom} for the ring-wrap regime — mirrors the
 * C# `++seen != dropPos` drop filter. */
function dropNthIFrameOnce(
  from: Endpoint,
  target: number,
): (f: Ax25Frame) => boolean {
  const fromCall = from.context.local.toString();
  let seen = -1;
  let dropped = false;
  return (f) => {
    if (dropped) return false;
    if (f.source.callsign.toString() !== fromCall) return false;
    if (classify(f) !== "I") return false;
    if (++seen !== target) return false;
    dropped = true;
    return true;
  };
}

describe("property: mod-8 SREJ wrapping burst recovers (the ring-wrap data-integrity fix)", () => {
  // The headline minimal repro: the exact reference shape. mod-8 SREJ, k=7,
  // station A bursts 8 frames, drop the second one (N(S)=1) once, then a clean
  // channel. Before the fix this delivered payloads [1..8, 1, 2] (1 and 2 twice)
  // and never reconverged; it must now deliver 1..8 exactly once, in order, and
  // the link must converge. Mirrors C#
  // `Mod8_srej_wrapping_burst_with_one_drop_does_not_re_deliver`.
  it("A→B mod-8 SREJ k=7 8-frame burst, drop N(S)=1 once: delivers 1..8 exactly once", () => {
    const h = TwoStationHarness.build({ srej: true, k: 7, extended: false, n2: 40 });
    h.connect();
    h.checkAfterEachStep = false;

    let dropped = false;
    h.dropWhen(
      withStormCap(h.link.log, (f) => {
        if (dropped) return false;
        if (!iFrameFrom(h.a, 1)(f)) return false; // the second frame, once
        dropped = true;
        return true;
      }),
    );

    h.submitBurst(h.a, 1, 2, 3, 4, 5, 6, 7, 8);
    expect(h.recoverUntilConverged(60)).toBe(true);

    expect(deliveredStream(h.b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    h.assertConverged();
  });

  // Every drop position across an 8-frame mod-8 SREJ burst at k=7 (the worst
  // case: k = modulus − 1, the whole ring in flight). Each must deliver 1..8
  // exactly once and converge — no re-delivery, no desync, at any wrap offset.
  // Mirrors C# `Mod8_srej_wrapping_burst_recovers_at_every_drop_position`.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "A→B mod-8 SREJ k=7 8-frame burst recovers when the on-wire frame #%i drops",
    (dropPos) => {
      const h = TwoStationHarness.build({ srej: true, k: 7, extended: false, n2: 40 });
      h.connect();
      h.checkAfterEachStep = false;
      h.dropWhen(withStormCap(h.link.log, dropNthIFrameOnce(h.a, dropPos)));

      h.submitBurst(h.a, 1, 2, 3, 4, 5, 6, 7, 8);
      expect(h.recoverUntilConverged(60)).toBe(true);

      expect(deliveredStream(h.b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      h.assertConverged();
    },
  );

  // Generative sweep of the ring-wrap regime: n ≥ k+1 frames bursting together
  // (so the sequence ring wraps) with a single drop, at BOTH modulos and BOTH
  // reject schemes. mod-8 caps k at 7 (the 3-bit window maximum); the extended
  // space exercises a much larger n through the same wrap machinery. The oracle
  // judges: exactly-once in-order delivery + convergence. Mirrors C#
  // `Wrapping_burst_with_one_drop_recovers`.
  it("over any (n ≥ k+1, dropPos, mode, modulo) with one drop", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.boolean(), // srej
        fc.boolean(), // extended (mod-8 / mod-128)
        (seedN, seedDrop, srej, extended) => {
          const k = extended ? 16 : 7; // mod-8 max window is 7
          const n = k + 1 + (seedN % (3 * k)); // ≥ k+1 ⇒ the ring necessarily wraps
          const dropPos = seedDrop % n;

          const h = TwoStationHarness.build({ srej, k, extended, n2: 80 });
          h.connect();
          h.checkAfterEachStep = false;
          h.dropWhen(withStormCap(h.link.log, dropNthIFrameOnce(h.a, dropPos)));

          // Distinct payloads (low byte of the index) so any reorder/dup shows.
          const payloads = Array.from({ length: n }, (_, i) => i & 0xff);
          h.submitBurst(h.a, ...payloads);
          expect(h.recoverUntilConverged(200)).toBe(true);

          expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
          h.assertConverged(); // exactly-once in-order delivery + empty windows
        },
      ),
      { numRuns: RUNS },
    );
  });

  /** Queue BOTH stations' wrapping bursts BEFORE settling, so the two transfers
   * (and their recoveries) interleave on the shared pump — the regime where each
   * ring wraps with frames in flight together. Posting directly (rather than via
   * {@link TwoStationHarness.submitBurst}, which settles per call) keeps both
   * rings in flight at once. A's payloads 0x10.., B's 0x80.. so any cross-talk is
   * observable. Mirrors the C# `Bidirectional_wrapping_bursts_recover` setup. */
  function runBidirectionalWrappingBurst(
    srej: boolean,
    extended: boolean,
    budget: number,
    patternSeed: number,
  ): TwoStationHarness {
    const k = extended ? 16 : 7;
    const n = k + 2; // > k ⇒ both rings wrap
    const h = TwoStationHarness.build({ srej, k, extended, n2: 80 });
    h.connect();
    h.checkAfterEachStep = false;

    const next = lcg(patternSeed);
    let dropsLeft = budget;
    h.dropWhen(
      withStormCap(h.link.log, () => {
        if (dropsLeft > 0 && next() < 0.5) {
          dropsLeft--;
          return true;
        }
        return false;
      }),
    );

    for (let i = 0; i < n; i++) {
      const a = Uint8Array.from([(0x10 + i) & 0xff]);
      const b = Uint8Array.from([(0x80 + i) & 0xff]);
      h.a.submitted.push(a);
      h.a.driver.postEvent({ name: "DL_DATA_request", data: a, pid: 0xf0 });
      h.b.submitted.push(b);
      h.b.driver.postEvent({ name: "DL_DATA_request", data: b, pid: 0xf0 });
    }
    h.settle();
    h.recoverUntilConverged(200);
    return h;
  }

  // Bidirectional / simultaneous WRAPPING bursts: both stations submit ≥ k frames
  // at once (each ring wraps) and the channel drops a finite budget in either
  // direction, then clears. Both directions must recover to exactly-once in-order
  // delivery and converge — the two-way analogue of the ring-wrap regime. Mirrors
  // the C# `Bidirectional_wrapping_bursts_recover` property.
  //
  // Generatively scoped over BOTH reject schemes (REJ go-back-N AND SREJ selective)
  // at BOTH modulos — full C# parity for SIMULTANEOUS bidirectional traffic. The
  // SREJ simultaneous-bidirectional ring-wrap residual that #285 left open (a rare
  // subset that tipped into the unguarded go-back-N `Invoke_Retransmission` path
  // where the C# reference stays in selective replay) is now closed by the figc4.5
  // Timer-Recovery drain fix (`ax25Spec47TimerRecoveryDrainAdvancesVR`,
  // packethacking/ax25spec#47, m0lte/packet.net#286): with V(R) advancing correctly
  // through the stored-frame drain, the receiver no longer spuriously SREJs and the
  // sender no longer tips into go-back-N (verified 0 failures over a dense
  // 50 000-case SREJ ring-wrap sweep, both modulos, budgets 0..4). The seeds the
  // pre-#286 known-failure file pinned (mod-8 LCG(1828421821), mod-128
  // LCG(4203678057)) are now deterministic positive controls below.
  it.each([
    ["REJ", false],
    ["SREJ", true],
  ] as const)(
    "%s (both modulos): both stations burst ≥ k+2 simultaneously and recover",
    (_label, srej) => {
      fc.assert(
        fc.property(
          fc.nat(),
          fc.integer({ min: 1, max: 1 << 20 }),
          fc.boolean(), // extended (mod-8 / mod-128)
          (seedBudget, patternSeed, extended) => {
            const budget = seedBudget % 5; // 0..4 finite drops, then clean
            const h = runBidirectionalWrappingBurst(srej, extended, budget, patternSeed);
            expect(h.converged()).toBe(true);
            h.assertConverged();
          },
        ),
        { numRuns: RUNS },
      );
    },
  );

  // Deterministic positive controls for SREJ simultaneous bidirectional wrapping
  // bursts at BOTH modulos — known-good seeds so the result is stable.
  it.each([
    ["mod-8", false],
    ["mod-128", true],
  ] as const)(
    "SREJ %s: a simultaneous bidirectional wrapping burst recovers (known-good pattern)",
    (_label, extended) => {
      const h = runBidirectionalWrappingBurst(true, extended, 3, 0xc0ffee);
      expect(deliveredStream(h.a)).toEqual(submittedStream(h.b));
      expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
      h.assertConverged();
    },
  );

  // ── R2 reference pins (packethacking/ax25spec#47, m0lte/packet.net#286) ──────
  //
  // The exact seeds the pre-#286 `srej-recovery-duplicate-delivery.known-failure`
  // file pinned as TS-only ring-wrap divergences (case 2): both stations burst
  // k+2 frames simultaneously (each ring wraps) under LCG budget 4 — mod-8
  // LCG(1828421821), mod-128 LCG(4203678057). Pre-#286, TS tipped into go-back-N
  // and failed to converge while the C# reference recovered in Connected selective
  // replay. The C# investigation (PR #286) found R2 is downstream of R1: the
  // figc4.5 stored-frame drain under-advanced V(R), which kept the receiver SREJ'ing
  // and the sender retransmitting — exactly what tips a station into the
  // enquiry→RR→go-back-N path. The R1 mirror (correct V(R) advance) closes R2 too,
  // with no separate selective-replay/Timer-Recovery sequencing change — TS now
  // matches the C# Connected-stays-selective behaviour these seeds pin. Mirrors the
  // C# `Bidirectional_srej_ringwrap_converges_on_pinned_seeds`.
  it.each([
    ["mod-8", false, 1828421821],
    ["mod-128", true, 4203678057],
  ] as const)(
    "R2 pin: SREJ %s simultaneous wrap burst (the pre-#286 TS-only seed) converges, each frame once",
    (_label, extended, patternSeed) => {
      const k = extended ? 16 : 7;
      const n = k + 2;
      const h = runBidirectionalWrappingBurst(true, extended, 4, patternSeed);
      h.assertConverged();
      const a = Array.from({ length: n }, (_, i) => (0x10 + i) & 0xff);
      const b = Array.from({ length: n }, (_, i) => (0x80 + i) & 0xff);
      expect(deliveredStream(h.b)).toEqual(a); // A→B, exactly once, in order
      expect(deliveredStream(h.a)).toEqual(b); // B→A, exactly once, in order
    },
  );
});

// Safety invariant under loss WITHOUT requiring convergence: at no intermediate
// point may a station deliver something out of order or a payload the peer never
// submitted. `checkSafety` (run by the harness after each step when enabled)
// already enforces this; here we assert it holds step-by-step under a fuzzed
// drop pattern even before the channel clears — delivered is always an in-order
// prefix of submitted. (Unidirectional A → B; see the scope note above.)
describe("property: delivered is always an in-order prefix of submitted (mid-recovery safety)", () => {
  it("no out-of-order or spurious delivery at any step under loss", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 1 << 20 }),
        (n, srej, extended, patternSeed) => {
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 40 });
          h.connect();
          // Leave per-step safety checks ON — the harness throws on any
          // out-of-order/duplicate delivery the moment it happens.
          const next = lcg(patternSeed);
          let dropsLeft = n; // finite
          h.dropWhen(
            withStormCap(h.link.log, () => {
              if (dropsLeft > 0 && next() < 0.5) {
                dropsLeft--;
                return true;
              }
              return false;
            }),
          );

          // Each submit() runs checkSafety() internally; a violation throws and
          // fails the property with the offending step. Distinct payloads.
          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);

          // Whatever was delivered so far is an in-order prefix of submitted.
          const delivered = deliveredStream(h.b);
          const submitted = submittedStream(h.a);
          expect(delivered).toEqual(submitted.slice(0, delivered.length));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// Positive control: the drop generator actually drops something across the
// sampled space (so "converges" isn't trivially satisfied by a clean channel).
describe("property harness self-check: loss is actually injected", () => {
  it("a forced single drop is observed on the wire then recovered", () => {
    const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
    h.connect();
    h.checkAfterEachStep = false;
    let dropped = false;
    h.dropWhen((f) => {
      if (dropped) return false;
      if (!iFrameFrom(h.a, 0)(f)) return false;
      dropped = true;
      return true;
    });
    for (let i = 0; i < 4; i++) h.submit(h.a, (i + 1) & 0xff);
    h.settle();
    // The targeted frame really hit the wire (and was swallowed).
    const i0 = h.link.log.filter((f) => classify(f) === "I" && getNs(f) === 0);
    expect(i0.length).toBeGreaterThanOrEqual(1);
    expect(dropped).toBe(true);
    h.recoverUntilConverged(40);
    expect(deliveredStream(h.b)).toEqual([1, 2, 3, 4]);
    h.assertConverged();
  });
});
