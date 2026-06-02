/**
 * Phase H — happy-path conformance. Drives the real two-station ax25-ts stack
 * through its normal operating envelope (no channel disruption) and asserts the
 * {@link InvariantChecker} oracle holds after every step. Proves both the stack
 * and the oracle on known-answer scenarios before any adversarial generation
 * (mirrors m0lte/packet.net `docs/conformance-harness-plan.md`, Phase H). The
 * harness runs the safety invariants automatically after each drive call, and
 * these tests additionally assert full convergence.
 *
 * ## Convergence (the delayed-ack flush — M0LTE/ax25-ts#12, fixed)
 *
 * These data-transfer cases assert full {@link TwoStationHarness.assertConverged}
 * (V(s) == V(a) + everything delivered), matching packet.net's equivalent suite.
 * That became reachable once #12 landed: the figc4.7 subroutine walker makes
 * `Enquiry Response (F = 0)` emit the acknowledging RR, and the dispatcher grants
 * LM-SEIZE immediately (posts `LM_SEIZE_confirm`) on the contention-free single-
 * session model — so the receiver acks, the sender's V(a) advances, and windows
 * reopen. The one remaining `.skip` is mod-128 connected-mode data (cf.
 * packet.net#239), unrelated to the ack flush.
 */
import { describe, expect, it } from "vitest";
import { TwoStationHarness } from "./two-station-harness.js";

describe("Phase H — happy-path conformance", () => {
  it("connect then clean disconnect", () => {
    const h = TwoStationHarness.build();
    h.connect();
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");

    h.disconnect(h.a);
    expect(h.a.state).toBe("Disconnected");
    expect(h.b.state).toBe("Disconnected");
  });

  it("connect initiated by B (either side may establish)", () => {
    const h = TwoStationHarness.build();
    h.connectFrom(h.b);
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
  });

  it("single I-frame A->B is delivered in order", () => {
    const h = TwoStationHarness.build();
    h.connect();

    h.submit(h.a, 0xaa);
    h.settle();

    // Reliable delivery holds (and is re-checked by the oracle after each step).
    expect(h.b.delivered.map((p) => Array.from(p))).toEqual([[0xaa]]);
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
  });

  it("full window A->B delivers in order", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    for (let i = 0; i < 4; i++) h.submit(h.a, i);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([0, 1, 2, 3]);
    expect(h.b.state).toBe("Connected");
    h.assertConverged();
  });

  it("bidirectional simultaneous data delivers both ways", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([0xa0, 0xa1]);
    expect(h.a.delivered.map((p) => p[0])).toEqual([0xb0, 0xb1]);
    h.assertConverged();
  });

  it("multi-window transfer wraps the modulus (V(s) 7->0) and converges", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    // 12 frames > the mod-8 window: V(s) wraps 7->0 as the delayed-ack flush
    // (#12) acknowledges each window and reopens it. All 12 are delivered in
    // order and the link converges.
    for (let i = 0; i < 12; i++) h.submit(h.a, i);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    h.assertConverged();
  });

  // ─── Pinned gaps (skipped, with issue refs) ──────────────────────────

  it("single I-frame A->B converges (V(s)==V(a))", () => {
    const h = TwoStationHarness.build();
    h.connect();
    h.submit(h.a, 0xaa);
    h.settle();
    // #12 fixed: the figc4.7 subroutine walker makes Enquiry Response (F = 0)
    // emit the acknowledging RR on LM_SEIZE_confirm, so B acks and A's V(a)
    // advances. Converges.
    h.assertConverged();
  });

  it.skip(
    "mod-128 (extended) data transfer — connected-mode data is mod-8-only (README scope; cf. packet.net#239)",
    () => {
      const h = TwoStationHarness.build({ extended: true });
      h.connect();
      // SABM/UA connect works, but the dispatcher doesn't honour mod-128 for
      // connected-mode I-frames (extended sequence numbers / 2-byte control are
      // route-around in the SDL predicates — see README "Scope" table). Mirrors
      // packet.net#239. Un-skip when extended data transfer lands.
      h.submit(h.a, 0x01);
      h.settle();
      expect(h.b.delivered.map((p) => p[0])).toEqual([0x01]);
    },
  );
});

describe("Phase H — oracle self-checks (known-answer)", () => {
  it("the oracle flags duplicate delivery", () => {
    const h = TwoStationHarness.build();
    h.connect();
    h.checkAfterEachStep = false; // we are about to forge an illegal state
    // Forge: B delivered a payload A never submitted.
    h.b.delivered.push(Uint8Array.from([0x99]));
    expect(() => h.checkInvariants()).toThrow(/duplicate or spurious delivery/);
  });

  it("the oracle flags an out-of-window send state", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false;
    // Forge a runaway V(s): 6 outstanding against k=4 (the #231 signature).
    h.a.context.vs = 6;
    h.a.context.va = 0;
    expect(() => h.checkInvariants()).toThrow(/window exceeded/);
  });

  it("the oracle flags a corrupted (mismatched) delivery", () => {
    const h = TwoStationHarness.build();
    h.connect();
    h.checkAfterEachStep = false;
    h.a.submitted.push(Uint8Array.from([0xaa]));
    h.b.delivered.push(Uint8Array.from([0xbb])); // wrong content
    expect(() => h.checkInvariants()).toThrow(/reorder\/corruption\/gap/);
  });
});
