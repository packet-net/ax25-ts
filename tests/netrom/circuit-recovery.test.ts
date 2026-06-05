/**
 * Loss-recovery + flow-control tests for the NET/ROM L4 circuit: selective-NAK
 * retransmission on a sequence gap, and choke backpressure. Driven through the
 * deterministic {@link CircuitPairHarness}.
 *
 * TS port of `tests/Packet.NetRom.Tests/Transport/NetRomCircuitRecoveryTests.cs`
 * — every `[Fact]` ported 1:1.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { CircuitManager } from "../../src/netrom/index.js";
import {
  ascii,
  asciiStr,
  CapturedCircuit,
  CircuitPairHarness,
} from "./circuit-pair-harness.js";

const User = new Callsign("M0LTE", 0);

describe("NetRomCircuit — loss recovery + flow control", () => {
  it("A_sequence_gap_triggers_a_NAK_and_selective_retransmit", () => {
    // Window 4, three frames sent together. Drop the FIRST (seq 0) on the wire; B
    // sees seq 1 out of order, NAKs seq 0, A retransmits from seq 0, and all three
    // deliver in order.
    const h = new CircuitPairHarness({ windowSize: 4, retransmitTimeoutMs: 30000 });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    h.dropNextAToB(); // drop the first Information (seq 0)
    a.circuit.send(Uint8Array.from([10]));
    a.circuit.send(Uint8Array.from([20]));
    a.circuit.send(Uint8Array.from([30]));
    h.pump(); // B receives seq 1,2 out of order → NAK seq 0 → A retransmits

    // the NAK-driven selective retransmit recovered the dropped frame, in order
    expect(accepted[0]!.received.map((r) => r[0])).toEqual([10, 20, 30]);
  });

  it("Choke_stops_the_sender_until_released", () => {
    // B self-chokes after one undelivered frame (chokeThreshold=1) and only drains
    // (releasing choke) when the test calls onDeliveryDrained. A must hold its
    // second frame back while choked, then send it once released.
    const h = new CircuitPairHarness({
      windowSize: 8,
      chokeThreshold: 1,
      retransmitTimeoutMs: 30000,
    });

    let bCap: CapturedCircuit | null = null;
    h.b.onIncomingCircuit((e) => {
      bCap = new CapturedCircuit(e.circuit);
      CircuitManager.acceptIncoming(e);
    });

    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();
    expect(bCap).not.toBeNull();
    const cap = bCap!;

    // First frame: B receives it and, because chokeThreshold=1, asserts choke on
    // its ack. A learns it is choked.
    a.circuit.send(ascii("one"));
    h.pump();
    expect(cap.received).toHaveLength(1);
    // B asserted choke after the first undelivered frame
    expect(a.circuit.peerChoked).toBe(true);

    // Second frame while choked: A must NOT put it on the wire.
    a.circuit.send(ascii("two"));
    h.pump();
    expect(cap.received).toHaveLength(1); // A is choked, so the second frame is held

    // B drains its backlog → releases choke → A resumes and the second frame
    // arrives. (With chokeThreshold=1, B will re-choke the moment "two" lands; the
    // point under test is that the gate opened and the held frame got through —
    // draining again then clears the re-choke.)
    cap.circuit.onDeliveryDrained();
    h.pump();
    expect(cap.received).toHaveLength(2); // the held frame went out once choke was released
    expect(asciiStr(cap.received[1]!)).toBe("two");

    cap.circuit.onDeliveryDrained(); // drain "two" → release the re-choke
    h.pump();
    // once B has fully drained, the sender is un-choked
    expect(a.circuit.peerChoked).toBe(false);
  });
});
