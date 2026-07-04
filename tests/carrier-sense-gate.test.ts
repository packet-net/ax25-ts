/**
 * Unit tests for {@link CarrierSenseGate} — the general carrier-sense CSMA gate
 * at the AX.25 listener's transmit path. TS port of the C#
 * `tests/Packet.Ax25.Tests/Session/CarrierSenseGateTests.cs`.
 *
 * The gate holds a keyup while the channel is busy and releases it when the
 * channel clears (or a bounded wait expires — fail-open). The clear / no-source /
 * unknown paths must key up immediately so a stack with no carrier-sense wired is
 * unchanged. Real timers with small slot/wait budgets keep these fast + deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  type CarrierSense,
  CarrierSenseGate,
} from "../src/carrier-sense.js";

/** A scripted carrier-sense source whose busy state the test flips. */
class FakeCarrierSense implements CarrierSense {
  busy: boolean | null;
  constructor(busy: boolean | null) {
    this.busy = busy;
  }
  channelBusy(): boolean | null {
    return this.busy;
  }
}

describe("CarrierSenseGate", () => {
  it("no source keys up immediately", async () => {
    const gate = new CarrierSenseGate(null);
    expect(gate.hasSource).toBe(false);
    // The always-clear degenerate gate: waitForClear returns 0 (no wait).
    await expect(gate.waitForClear()).resolves.toBe(0);
  });

  it("clear channel keys up immediately", async () => {
    const gate = new CarrierSenseGate(new FakeCarrierSense(false));
    expect(gate.hasSource).toBe(true);
    await expect(gate.waitForClear()).resolves.toBe(0);
  });

  it("unknown busy state fails open immediately", async () => {
    // null = "no report yet / cannot sense" — must not wedge traffic.
    const gate = new CarrierSenseGate(new FakeCarrierSense(null));
    await expect(gate.waitForClear()).resolves.toBe(0);
  });

  it("gatedSend runs the send synchronously when the channel is clear", () => {
    const gate = new CarrierSenseGate(new FakeCarrierSense(false));
    let sent = false;
    gate.gatedSend(() => {
      sent = true;
    });
    // No source deferral: the send ran inline, before gatedSend returned — the
    // byte-for-byte fast path (no microtask hop).
    expect(sent).toBe(true);
  });

  it("gatedSend defers the send while the channel is busy, then keys up on clear", async () => {
    const cs = new FakeCarrierSense(true);
    const gate = new CarrierSenseGate(cs, { slotTimeMs: 10 });
    let sent = false;
    gate.gatedSend(() => {
      sent = true;
    });

    // Busy at call time → the send is held (did not run synchronously).
    expect(sent).toBe(false);
    await new Promise((r) => setTimeout(r, 25));
    expect(sent).toBe(false);

    // Channel clears; one slot later the gate re-samples and keys up.
    cs.busy = false;
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toBe(true);
  });

  it("busy channel defers waitForClear until the carrier clears", async () => {
    const cs = new FakeCarrierSense(true);
    const gate = new CarrierSenseGate(cs, { slotTimeMs: 10 });

    const wait = gate.waitForClear();
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false); // still busy — the keyup is held

    cs.busy = false;
    const waited = await wait;
    expect(waited).toBeGreaterThan(0); // the transmission waited for the channel to clear
  });

  it("bounded wait expiry fails open by default", async () => {
    const cs = new FakeCarrierSense(true); // never clears
    const gate = new CarrierSenseGate(cs, { slotTimeMs: 10, maxWaitMs: 30 });

    // Fail-open keys up after the bounded wait rather than dropping the frame.
    const waited = await gate.waitForClear();
    expect(waited).toBeGreaterThanOrEqual(30);
  });

  it("bounded wait expiry throws when fail-open is disabled", async () => {
    const cs = new FakeCarrierSense(true);
    const gate = new CarrierSenseGate(cs, {
      slotTimeMs: 10,
      maxWaitMs: 30,
      failOpen: false,
    });

    // Fail-open disabled surfaces the busy-channel timeout.
    await expect(gate.waitForClear()).rejects.toThrow(/still busy/);
  });
});
