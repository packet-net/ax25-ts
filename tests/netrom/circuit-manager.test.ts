/**
 * Tests for {@link CircuitManager}: the circuit-table demultiplex (two concurrent
 * circuits stay independent), inbound-connect minting + refusal, and tolerance of
 * stray datagrams.
 *
 * TS port of `tests/Packet.NetRom.Tests/Transport/CircuitManagerTests.cs` — every
 * `[Fact]` ported 1:1.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  buildConnectRequestInfo,
  CircuitManager,
  type IncomingCircuitEvent,
  NetRomCircuitCloseReason,
  NetRomCircuitState,
  type NetRomPacket,
  NetRomOpcode,
  NetRomTransportFlags,
} from "../../src/netrom/index.js";
import { ascii, asciiStr, CircuitPairHarness } from "./circuit-pair-harness.js";

const User = new Callsign("M0LTE", 0);
const Local = new Callsign("GB7XXX", 0);
const Peer = new Callsign("GB7YYY", 0);
const Third = new Callsign("GB7ZZZ", 0);

/** A Connect Request from `origin` naming ITS OWN circuit `(index,id)`. */
function connectRequestFrom(
  origin: Callsign,
  index: number,
  id: number,
): NetRomPacket {
  return {
    network: { origin, destination: Local, timeToLive: 25 },
    transport: {
      circuitIndex: index,
      circuitId: id,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.ConnectRequest,
      flags: NetRomTransportFlags.None,
    },
    payload: buildConnectRequestInfo(4, User, origin),
  };
}

describe("CircuitManager", () => {
  it("Two_concurrent_circuits_demultiplex_independently", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();

    const c1 = h.openFromA();
    c1.circuit.connect(User);
    h.pump();
    const c2 = h.openFromA();
    c2.circuit.connect(new Callsign("G0ABC"));
    h.pump();

    expect(accepted).toHaveLength(2);

    // Each carries its own data; the manager routes by the (index,id) key.
    c1.circuit.send(ascii("circuit one"));
    c2.circuit.send(ascii("circuit two"));
    h.pump();

    // Match accepted circuits to senders by what they received (order of accept
    // matches order of connect).
    expect(asciiStr(accepted[0]!.receivedBytes)).toBe("circuit one");
    expect(asciiStr(accepted[1]!.receivedBytes)).toBe("circuit two");
  });

  it("Closed_circuits_are_removed_from_the_table", () => {
    const h = new CircuitPairHarness();
    h.autoAcceptOnB();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();
    expect(h.a.circuits).toHaveLength(1);

    a.circuit.disconnect();
    h.pump();
    // a disconnected circuit deregisters from the manager
    expect(h.a.circuits).toHaveLength(0);
    expect(h.b.circuits).toHaveLength(0);
  });

  it("A_retransmitted_connect_request_does_not_mint_a_duplicate_inbound_circuit", () => {
    // Drop B's first Connect Acknowledge so A retransmits its Connect Request. The
    // retransmit's header names A's circuit (not B's), so it can't match B's
    // local-key table — B must dedup it by the peer identity and re-ack, NOT mint
    // a second inbound circuit.
    const h = new CircuitPairHarness({ retransmitTimeoutMs: 5000, maxRetries: 3 });
    const accepted = h.autoAcceptOnB();
    const a = h.openFromA();

    h.dropNextBToA(); // lose B's first Connect Acknowledge
    a.circuit.connect(User);
    h.pump();
    expect(a.connected).toBe(false); // the connect-ack was dropped
    expect(h.b.circuits).toHaveLength(1); // B minted exactly one inbound circuit

    h.advance(6000); // A retransmits the Connect Request
    expect(a.connected).toBe(true); // the re-ack from the deduped circuit completes the connect
    expect(h.b.circuits).toHaveLength(1); // the retransmit re-acked the existing circuit, no duplicate
    expect(accepted).toHaveLength(1); // IncomingCircuit fired exactly once
  });

  it("A_connect_request_whose_key_collides_with_a_live_local_circuit_is_still_routed_to_the_peer", () => {
    // Circuit keys are per-node and every node allocates from (0,0), so a third
    // node's FIRST connect carries the same (index,id) as our own first circuit.
    // A connect names the PEER's circuit, so it must be routed by
    // (origin,index,id), never demuxed onto ours, which would swallow it (no
    // incoming-circuit event) or, once our circuit is up, ack the wrong node.
    const manager = new CircuitManager(Local);
    const sent: NetRomPacket[] = [];
    manager.sendPacket = (p) => sent.push(p);
    const incoming: IncomingCircuitEvent[] = [];
    manager.onIncomingCircuit((e) => {
      incoming.push(e);
      CircuitManager.acceptIncoming(e);
    });

    // Our own outbound circuit to GB7YYY takes the first key, (0,0), and is live.
    const ours = manager.openCircuit(Peer);
    ours.connect(User);
    expect([ours.localIndex, ours.localId]).toEqual([0, 0]);
    sent.length = 0;

    // A THIRD node's fresh circuit is (0,0) too; its Connect Request names it.
    manager.onPacket(connectRequestFrom(Third, 0, 0));

    // the colliding connect must mint an inbound circuit
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.remoteNode.equals(Third)).toBe(true);
    expect(sent).toHaveLength(1);
    const ack = sent[0]!;
    expect(ack.transport.opcode).toBe(NetRomOpcode.ConnectAcknowledge);
    // the acknowledgement goes to the node that connected
    expect(ack.network.destination.equals(Third)).toBe(true);
    expect(ack.transport.circuitIndex).toBe(0); // addressed to the peer's own circuit
    // our colliding circuit is untouched
    expect(ours.state).toBe(NetRomCircuitState.Connecting);
  });

  it("An_inbound_connect_with_no_listener_is_refused", () => {
    // No incoming-circuit handler subscribed → the manager refuses rather than
    // leaving a dangling half-open circuit.
    const h = new CircuitPairHarness();
    const a = h.openFromA();
    a.circuit.connect(User);
    h.pump();

    expect(a.connected).toBe(false);
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]).toBe(NetRomCircuitCloseReason.Refused);
    expect(h.b.circuits).toHaveLength(0); // the refused inbound circuit was deregistered
  });

  it("A_stray_datagram_for_an_unknown_circuit_is_dropped_without_throwing", () => {
    const manager = new CircuitManager(new Callsign("GB7XXX"));
    const sent: NetRomPacket[] = [];
    manager.sendPacket = (p) => sent.push(p);

    // An Information datagram naming a circuit that does not exist.
    const stray: NetRomPacket = {
      network: {
        origin: new Callsign("GB7YYY"),
        destination: new Callsign("GB7XXX"),
        timeToLive: 10,
      },
      transport: {
        circuitIndex: 99,
        circuitId: 99,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.Information,
        flags: NetRomTransportFlags.None,
      },
      payload: Uint8Array.from([1, 2, 3]),
    };

    expect(() => manager.onPacket(stray)).not.toThrow();
    expect(sent).toHaveLength(0); // a stray Information datagram is silently dropped
  });

  it("A_disconnect_for_an_unknown_circuit_is_courteously_acknowledged", () => {
    const manager = new CircuitManager(new Callsign("GB7XXX"));
    const sent: NetRomPacket[] = [];
    manager.sendPacket = (p) => sent.push(p);

    const disc: NetRomPacket = {
      network: {
        origin: new Callsign("GB7YYY"),
        destination: new Callsign("GB7XXX"),
        timeToLive: 10,
      },
      transport: {
        circuitIndex: 5,
        circuitId: 5,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.DisconnectRequest,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array(0),
    };
    manager.onPacket(disc);

    expect(sent).toHaveLength(1);
    // a half-open peer's disconnect is acked so it stops retransmitting
    expect(sent[0]!.transport.opcode).toBe(NetRomOpcode.DisconnectAcknowledge);
  });
});
