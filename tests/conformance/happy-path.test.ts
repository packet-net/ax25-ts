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
 * reopen. mod-128 (extended) connected-mode data is now covered here too — the
 * "mod-128 (extended) windowed data transfer converges" case below is un-skipped
 * and green (cf. packet.net#239), and the wire leg lives in the
 * `tests/integration/mod128-*` suite (ax25-ts#69).
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

  // ax25spec#43: figc4.4 as drawn gated DL-FLOW-OFF's Set-Own-Receiver-Busy/RNR
  // actions on the already-busy branch, so a not-busy station could never enter
  // busy via DL-FLOW-OFF. With `ax25Spec43DlFlowOffEntersBusy` on (default) the
  // own_receiver_busy guard is inverted for that trigger, so DL-FLOW-OFF sets
  // own-receiver-busy + sends RNR, the peer registers peer-busy and pauses, and
  // DL-FLOW-ON resumes the flow. Mirrors packet.net's
  // EnvelopeConformanceTests.Rnr_flow_control_pauses_then_resumes_the_sender.
  it("RNR flow control pauses then resumes the sender (ax25spec#43)", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    h.submit(h.a, 0xa0);
    expect(h.b.delivered.map((p) => p[0])).toEqual([0xa0]);

    // B goes busy → RNR → A must register peer-busy and stop sending.
    h.setBusy(h.b);
    expect(h.a.context.peerReceiverBusy).toBe(true);

    // While the peer is busy the second frame must NOT be delivered.
    h.submit(h.a, 0xa1);
    expect(h.b.delivered.map((p) => p[0])).toEqual([0xa0]);

    // B clears busy → RR → A resumes and the queued frame flows.
    h.clearBusy(h.b);
    h.recoverUntilConverged(8);

    expect(h.b.delivered.map((p) => p[0])).toEqual([0xa0, 0xa1]);
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

  it("mod-128 (extended) windowed data transfer converges", () => {
    // v2.2 arc V1 (TS parity leg of packet.net#266 /
    // EnvelopeConformanceTests.Mod128_extended_window_transfer_converges):
    // a full session-level mod-128 windowed transfer over the two-station
    // harness. The harness builds both endpoints with isExtended set, so the
    // I/S frames carry the 2-octet extended control field; the dispatcher
    // emits 7-bit N(S)/N(R) and the receive path re-decodes at mod-128.
    const h = TwoStationHarness.build({ extended: true, k: 8 });
    h.connect();
    expect(h.a.context.isExtended).toBe(true);
    expect(h.b.context.isExtended).toBe(true);

    for (let i = 0; i < 8; i++) h.submit(h.a, i);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    h.assertConverged();
  });
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
