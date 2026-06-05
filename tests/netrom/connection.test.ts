/**
 * Direct, deterministic coverage of {@link NetRomConnection} — the duplex byte
 * stream that wraps a NET/ROM L4 {@link NetRomCircuit} (the far side of
 * `connect <alias>`, and the wrapper for an inbound circuit). Driven over TS-2's
 * fake-clock {@link CircuitPairHarness} (no AX.25 layer), so the connection's
 * data-buffering / dispose / completion semantics are pinned down on a synchronous,
 * reproducible channel — complementing the real-AX.25 integration coverage in
 * `connector.test.ts`.
 *
 * Mirrors the connection-shape assertions the C# `NetRomNodeConnection` tests make
 * (the C# `NetRomCircuitTests` exercise the circuit; the node connection's
 * buffer-then-read + dispose-DISCs behaviour is the TS analogue here).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  NetRomCircuitState,
  NetRomConnection,
} from "../../src/netrom/index.js";
import { CircuitPairHarness, ascii, asciiStr } from "./circuit-pair-harness.js";

describe("NetRomConnection — duplex stream over an L4 circuit", () => {
  it("delivers reassembled data to onData and round-trips writes both ways", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();

    const aCircuit = h.a.openCircuit(h.bNode);
    const connA = new NetRomConnection(aCircuit, h.bNode);
    const aReceived: Uint8Array[] = [];
    connA.onData((c) => aReceived.push(c));

    aCircuit.connect(new Callsign("M0LTE", 7));
    h.pump();

    expect(connA.circuit.state).toBe(NetRomCircuitState.Connected);
    expect(accepted.length).toBe(1);
    const bCircuit = accepted[0]!.circuit;
    const connB = new NetRomConnection(bCircuit, h.aNode);
    const bReceived: Uint8Array[] = [];
    connB.onData((c) => bReceived.push(c));

    // A → B over the connection.
    connA.write(ascii("ping"));
    h.pump();
    expect(asciiStr(concat(bReceived))).toBe("ping");

    // B → A over the connection.
    connB.write(ascii("pong"));
    h.pump();
    expect(asciiStr(concat(aReceived))).toBe("pong");
  });

  it("buffers inbound data that arrives before a reader attaches, then flushes in order", () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();

    const aCircuit = h.a.openCircuit(h.bNode);
    const connA = new NetRomConnection(aCircuit, h.bNode);
    aCircuit.connect(new Callsign("M0LTE", 7));
    h.pump();
    const connB = new NetRomConnection(accepted[0]!.circuit, h.aNode);

    // B sends two frames to A *before* A subscribes any onData listener.
    connB.write(ascii("first"));
    h.pump();
    connB.write(ascii("second"));
    h.pump();

    // Now A attaches a reader — both buffered frames flush, in order.
    const aReceived: Uint8Array[] = [];
    connA.onData((c) => aReceived.push(c));
    expect(aReceived.map(asciiStr)).toEqual(["first", "second"]);

    // A later frame is delivered live (no double-delivery of the buffered ones).
    connB.write(ascii("third"));
    h.pump();
    expect(aReceived.map(asciiStr)).toEqual(["first", "second", "third"]);
  });

  it("dispose disconnects the circuit and settles completion + closed", async () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();
    const aCircuit = h.a.openCircuit(h.bNode);
    const connA = new NetRomConnection(aCircuit, h.bNode);
    aCircuit.connect(new Callsign("M0LTE", 7));
    h.pump();

    let closedCount = 0;
    connA.onClosed(() => {
      closedCount++;
    });
    expect(connA.closed).toBe(false);

    connA.dispose();
    h.pump(); // let the Disconnect Request / Acknowledge settle on the wire

    await connA.completion; // resolves on dispose
    // onClosed fires exactly once even though dispose() and the circuit's own close
    // (the Disconnect Acknowledge) both reach complete().
    expect(closedCount).toBe(1);
    expect(connA.closed).toBe(true);
    expect(aCircuit.state).toBe(NetRomCircuitState.Disconnected);
    expect(accepted[0]!.circuit.state).toBe(NetRomCircuitState.Disconnected);
  });

  it("settles completion + fires onClosed when the peer disconnects the circuit", async () => {
    const h = new CircuitPairHarness();
    const accepted = h.autoAcceptOnB();
    const aCircuit = h.a.openCircuit(h.bNode);
    const connA = new NetRomConnection(aCircuit, h.bNode);
    aCircuit.connect(new Callsign("M0LTE", 7));
    h.pump();

    let closedFired = false;
    connA.onClosed(() => {
      closedFired = true;
    });

    // The PEER (B) disconnects — A's connection should settle from the circuit close.
    accepted[0]!.circuit.disconnect();
    h.pump();

    await connA.completion;
    expect(closedFired).toBe(true);
    expect(connA.closed).toBe(true);
  });

  it("write after dispose is a no-op (does not throw)", () => {
    const h = new CircuitPairHarness();
    h.autoAcceptOnB();
    const aCircuit = h.a.openCircuit(h.bNode);
    const connA = new NetRomConnection(aCircuit, h.bNode);
    aCircuit.connect(new Callsign("M0LTE", 7));
    h.pump();

    connA.dispose();
    h.pump();
    expect(() => connA.write(ascii("ignored"))).not.toThrow();
  });
});

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
