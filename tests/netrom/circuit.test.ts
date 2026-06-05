/**
 * Behavioural tests for the NET/ROM L4 circuit FSM, driven through the
 * deterministic {@link CircuitPairHarness} (two managers + a controllable channel
 * + shared fake clock). Covers the full vanilla transport: connect/ack with
 * window negotiation, info/info-ack over the sliding window, disconnect/ack,
 * retransmit on loss, and L4 fragment/reassembly.
 *
 * TS port of `tests/Packet.NetRom.Tests/Transport/NetRomCircuitTests.cs` — every
 * `[Fact]` ported 1:1.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NetRomCircuitCloseReason,
  NetRomCircuitState,
} from "../../src/netrom/index.js";
import { ascii, CircuitPairHarness } from "./circuit-pair-harness.js";

const User = new Callsign("M0LTE", 0);

describe("NetRomCircuit — behavioural FSM", () => {
  it("Connect_then_acknowledge_brings_both_ends_up", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();

    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    expect(a.connected).toBe(true); // the Connect Acknowledge reached the originator
    expect(a.circuit.state).toBe(NetRomCircuitState.Connected);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.circuit.state).toBe(NetRomCircuitState.Connected);
    // B learned the originating node from the L3 header
    expect(accepted[0]!.circuit.remoteNode.equals(h.aNode)).toBe(true);
  });

  it("Window_is_negotiated_down_to_the_responders_ceiling", () => {
    // A proposes a window of 8; B's ceiling is 2. The accepted (B-side) window
    // must clamp to B's smaller ceiling — the canonical "accepted ≤ proposed".
    const h = new CircuitPairHarness({ windowSize: 8 }, { windowSize: 2 });
    const accepted = h.autoAcceptOnB();

    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    expect(accepted).toHaveLength(1);
    // B accepts at most its own ceiling, below A's proposed 8
    expect(accepted[0]!.circuit.window).toBe(2);
  });

  it("Information_flows_with_piggybacked_acks", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    const payload = ascii("hello netrom");
    a.circuit.send(payload);
    h.pump();

    expect([...accepted[0]!.receivedBytes]).toEqual([...payload]); // B received the Information payload

    // And the reverse direction.
    const reply = ascii("hi back");
    accepted[0]!.circuit.send(reply);
    h.pump();
    expect([...a.receivedBytes]).toEqual([...reply]);
  });

  it("A_multi_frame_burst_delivers_in_order_within_the_window", () => {
    const h = new CircuitPairHarness({ windowSize: 4 });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    // Six one-byte logical sends — more than the window, so the queue drains as
    // acks return.
    for (let i = 1; i <= 6; i++) {
      a.circuit.send(Uint8Array.from([i]));
    }
    h.pump();

    expect(accepted[0]!.received).toHaveLength(6);
    expect(accepted[0]!.received.map((r) => r[0])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("A_large_payload_fragments_and_reassembles_at_236_bytes", () => {
    const h = new CircuitPairHarness({ windowSize: 8 });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    // 600 bytes → 236 + 236 + 128, three Information messages (more-follows on the
    // first two), reassembled to one logical frame on B.
    const big = new Uint8Array(600);
    for (let i = 0; i < big.length; i++) {
      big[i] = i & 0xff;
    }
    a.circuit.send(big);
    h.pump();

    // the fragments reassemble to one logical frame
    expect(accepted[0]!.received).toHaveLength(1);
    expect([...accepted[0]!.received[0]!]).toEqual([...big]);
  });

  it("Disconnect_is_acknowledged_and_closes_both_ends", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    a.circuit.disconnect();
    h.pump();

    expect(a.circuit.state).toBe(NetRomCircuitState.Disconnected);
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]).toBe(NetRomCircuitCloseReason.Normal);
    expect(accepted[0]!.circuit.state).toBe(NetRomCircuitState.Disconnected);
    expect(accepted[0]!.closed).toContain(NetRomCircuitCloseReason.Normal);
  });

  it("A_refused_connect_closes_the_originator_as_refused", () => {
    const h = new CircuitPairHarness();
    h.b.onIncomingCircuit((e) => h.b.refuseIncoming(e));

    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    expect(a.connected).toBe(false);
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]).toBe(NetRomCircuitCloseReason.Refused);
    expect(a.circuit.state).toBe(NetRomCircuitState.Disconnected);
  });

  it("A_lost_information_frame_is_retransmitted_after_the_timeout", () => {
    const h = new CircuitPairHarness({
      windowSize: 4,
      retransmitTimeoutMs: 5000,
      maxRetries: 3,
    });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    // Drop the next A→B datagram (the Information), so B never sees it.
    h.dropNextAToB();
    const payload = ascii("retransmit me");
    a.circuit.send(payload);
    h.pump();
    expect(accepted[0]!.received).toHaveLength(0); // the only copy was dropped

    // After the retransmit timeout, the tick retransmits it and B receives it.
    h.advance(6000);
    // the retransmit delivered the data
    expect([...accepted[0]!.receivedBytes]).toEqual([...payload]);
  });

  it("A_lost_connect_request_is_retransmitted_then_succeeds", () => {
    const h = new CircuitPairHarness({ retransmitTimeoutMs: 5000, maxRetries: 3 });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();

    h.dropNextAToB(); // lose the first Connect Request
    a.circuit.connect(User);
    h.pump();
    expect(a.connected).toBe(false);

    h.advance(6000); // retransmit the connect
    expect(a.connected).toBe(true); // the retransmitted Connect Request was acknowledged
    expect(accepted).toHaveLength(1);
  });

  it("Connect_fails_after_retries_are_exhausted", () => {
    const h = new CircuitPairHarness({ retransmitTimeoutMs: 5000, maxRetries: 2 });
    h.autoAcceptOnB();
    const a = h.openFromA();

    // Drop every connect attempt (original + 2 retries).
    h.dropNextAToB(3);
    a.circuit.connect(User);
    h.pump();

    h.advance(6000); // retry 1 (dropped)
    h.advance(6000); // retry 2 (dropped) → exhausted
    h.advance(6000); // tick that trips the give-up

    expect(a.connected).toBe(false);
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]).toBe(NetRomCircuitCloseReason.Timeout);
  });
});
