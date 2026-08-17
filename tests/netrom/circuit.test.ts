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
  buildConnectRequestInfo,
  CircuitManager,
  CONNECT_ACK_INFO_VANILLA_LENGTH,
  encodeNetRomPacket,
  NetRomCircuitCloseReason,
  NetRomCircuitState,
  NetRomOpcode,
  type NetRomPacket,
  NetRomTransportFlags,
} from "../../src/netrom/index.js";
import { ascii, CircuitPairHarness } from "./circuit-pair-harness.js";

const User = new Callsign("M0LTE", 0);

/**
 * Feed one Connect Request into a lone manager for `local` and return every
 * Connect Acknowledge it emitted, so the acknowledgement's info field can be
 * inspected on the wire.
 */
function connectAcksFor(
  local: Callsign,
  windowSize: number,
  accept: boolean,
  proposedWindow = 7,
): NetRomPacket[] {
  const remote = new Callsign("GB7AAA", 0);
  const acks: NetRomPacket[] = [];
  const manager = new CircuitManager(local, { windowSize });
  manager.sendPacket = (p) => {
    if (p.transport.opcode === NetRomOpcode.ConnectAcknowledge) {
      acks.push(p);
    }
  };
  manager.onIncomingCircuit((e) => {
    if (accept) {
      CircuitManager.acceptIncoming(e);
    } else {
      manager.refuseIncoming(e);
    }
  });

  manager.onPacket({
    network: { origin: remote, destination: local, timeToLive: 25 },
    transport: {
      circuitIndex: 7,
      circuitId: 3,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.ConnectRequest,
      flags: NetRomTransportFlags.None,
    },
    payload: buildConnectRequestInfo(proposedWindow, User, remote),
  });
  return acks;
}

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

  it("The_originator_clamps_its_send_window_to_the_accepted_window", () => {
    // The other half of the negotiation: B's Connect Acknowledge reports the
    // window it ACCEPTED (info[0]) and the originator must come down to it.
    // Sending more frames than the far end agreed to hold overruns its receive
    // queue. LinBPQ does exactly this on receipt: L4->L4WINDOW = L3MSG->L4DATA[0]
    // (L4Code.c:2287).
    const h = new CircuitPairHarness({ windowSize: 8 }, { windowSize: 2 });
    h.autoAcceptOnB();

    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    expect(a.connected).toBe(true);
    // the acknowledgement's window octet caps our proposed 8
    expect(a.circuit.window).toBe(2);
  });

  it("An_acknowledgement_with_no_window_octet_leaves_our_proposal_standing", () => {
    // A terse peer that sends a bare 20-byte Connect Acknowledge tells us
    // nothing, so our proposed window stands (never silently zeroed).
    const aNode = new Callsign("GB7AAA", 0);
    const bNode = new Callsign("GB7BBB", 0);
    const manager = new CircuitManager(aNode, { windowSize: 4 });
    const sent: NetRomPacket[] = [];
    manager.sendPacket = (p) => sent.push(p);

    const circuit = manager.openCircuit(bNode);
    circuit.connect(User);
    expect(sent).toHaveLength(1);

    manager.onPacket({
      network: { origin: bNode, destination: aNode, timeToLive: 25 },
      transport: {
        circuitIndex: circuit.localIndex,
        circuitId: circuit.localId,
        txSequence: 1,
        rxSequence: 1,
        opcode: NetRomOpcode.ConnectAcknowledge,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array(0),
    });

    expect(circuit.state).toBe(NetRomCircuitState.Connected);
    expect(circuit.window).toBe(4); // no octet to clamp to, so the proposal stands
  });

  it("A_vanilla_connect_acknowledge_is_21_bytes_carrying_the_accepted_window", () => {
    // The accepted-window octet is base NET/ROM, not a compression extension:
    // LinBPQ's SendConACK writes L4DATA[0] = L4WINDOW and sends
    // LENGTH = MSGHDDRLEN + 22, a 21-byte vanilla ack (L4Code.c:1768,1824), and
    // Linux emits nr->window with NR_CONNACK_LEN 1. Without it the peer reads
    // buffer residue for our window.
    const acks = connectAcksFor(new Callsign("GB7BBB", 0), 4, true);

    expect(acks).toHaveLength(1);
    const ack = acks[0]!;
    // the vanilla ack carries the window octet and nothing else
    expect(ack.payload).toHaveLength(CONNECT_ACK_INFO_VANILLA_LENGTH);
    expect(ack.payload[0]).toBe(4); // the accepted window: our ceiling, below the proposed 7
    // 20-byte NET/ROM header + the accepted-window octet
    expect(encodeNetRomPacket(ack)).toHaveLength(21);
  });

  it("A_refusing_connect_acknowledge_carries_no_info_field", () => {
    // A refusal accepts nothing, so it carries no window octet, matching Linux's
    // nr_transmit_refusal (a bare 20-byte frame); the originator closes on the
    // choke bit before any window is read either way.
    const acks = connectAcksFor(new Callsign("GB7BBB", 0), 4, false);

    expect(acks).toHaveLength(1);
    const ack = acks[0]!;
    expect(ack.payload).toHaveLength(0);
    expect(encodeNetRomPacket(ack)).toHaveLength(20);
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
