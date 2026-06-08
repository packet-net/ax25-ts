/**
 * Deterministic tests for {@link Inp3Engine} (the INP3 link-timing engine, slice
 * I-2) driven by a fake clock: probe-fires-on-cadence, reflection-updates-SNTT,
 * peer-probe-is-reflected, capability-learned, and the 180 s no-reflection reset
 * fires {@link Inp3Engine.onNeighbourDown} for an INP3-capable neighbour (and
 * resets it) — plus the AMBIGUITY-I2-3 guard that a never-capable vanilla
 * neighbour is dropped silently.
 *
 * TS port of `tests/Packet.NetRom.Tests/Transport/Inp3EngineTests.cs` — every
 * `[Fact]` ported 1:1 (same cases, same assertions, same boundary values). The C#
 * `FakeTimeProvider` + `clock.Advance(TimeSpan)` maps to a mutable `nowMs`
 * counter + an `advance(ms)` helper feeding the engine's injected `now()`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  Inp3Engine,
  type Inp3NeighbourDownEvent,
} from "../../src/netrom/inp3-engine.js";
import { Inp3L3RttFrame } from "../../src/netrom/inp3-l3rtt.js";
import type { Inp3Options } from "../../src/netrom/inp3-options.js";
import {
  type NetRomPacket,
  NetRomOpcode,
  NetRomTransportFlags,
} from "../../src/netrom/index.js";

const Local = new Callsign("GB7PDN", 0);
const Peer = new Callsign("GB7RDG", 0);

/** A test clock the engine reads through its injected `now()`; `advance(ms)`
 *  is the analogue of the C# `FakeTimeProvider.Advance(TimeSpan)`. */
class FakeClock {
  private ms = 0;
  readonly now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface Sent {
  neighbour: Callsign;
  frame: Inp3L3RttFrame;
}

function newEngine(
  clock: FakeClock,
  options: Inp3Options | undefined,
): { engine: Inp3Engine; sent: Sent[] } {
  const sent: Sent[] = [];
  const engine = new Inp3Engine(Local, options, clock.now);
  engine.sendL3Rtt = (neighbour, frame) => sent.push({ neighbour, frame });
  return { engine, sent };
}

describe("Inp3Engine", () => {
  it("Probe_fires_on_cadence_and_not_before", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
    };
    const { engine, sent } = newEngine(clock, opts);

    engine.observeNeighbour(Peer);

    // First tick: never-probed neighbour is immediately due.
    engine.tick();
    expect(sent).toHaveLength(1); // freshly-observed neighbour is probed on the first tick
    expect(sent[0]!.neighbour.equals(Peer)).toBe(true);
    expect(sent[0]!.frame.packet.network.origin.equals(Local)).toBe(true); // probe carries our node as L3 origin
    expect(sent[0]!.frame.packet.network.destination.base).toBe(
      Inp3L3RttFrame.L3RttBase,
    );

    // A probe is outstanding (awaitingReflection) — no re-probe even past cadence.
    sent.length = 0;
    clock.advance(120_000);
    engine.tick();
    expect(sent).toHaveLength(0); // a neighbour with a probe in flight is never re-probed
  });

  it("Probe_does_not_re_fire_within_cadence_after_reflection", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
    };
    const { engine, sent } = newEngine(clock, opts);

    engine.observeNeighbour(Peer);
    engine.tick(); // probe #1 at t=0
    expect(sent).toHaveLength(1);

    // Reflect it 1 s later so the outstanding-probe flag clears.
    clock.advance(1_000);
    engine.onL3Rtt(Peer, sent[0]!.frame); // our own probe echoed back
    sent.length = 0;

    // 30 s after probe #1 (< 60 s cadence) → no new probe.
    clock.advance(29_000);
    engine.tick();
    expect(sent).toHaveLength(0); // cadence has not elapsed since the last send

    // Past the 60 s mark since probe #1 → probe #2 fires.
    clock.advance(31_000);
    engine.tick();
    expect(sent).toHaveLength(1); // the next probe fires once the cadence has elapsed
  });

  it("Reflection_of_our_probe_updates_SNTT_with_half_the_round_trip", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
    };
    const { engine, sent } = newEngine(clock, opts);

    engine.observeNeighbour(Peer);
    engine.tick(); // probe at t=0
    const ourProbe = sent[0]!.frame;

    expect(engine.snttMs(Peer)).toBeNull(); // no measurement before the first reflection

    // Reflection arrives 400 ms later → RTT = 400, sample = RTT/2 = 200; the first
    // sample seeds the filter directly (SRT/Karn cold-start).
    clock.advance(400);
    engine.onL3Rtt(Peer, ourProbe);

    expect(engine.snttMs(Peer)).toBe(200); // first reflection seeds SNTT = RTT/2

    expect(engine.neighbours).toHaveLength(1);
    const timing = engine.neighbours[0]!;
    expect(timing.neighbour.equals(Peer)).toBe(true);
    expect(timing.snttMs).toBe(200);
    expect(timing.awaitingReflection).toBe(false); // the outstanding-probe flag cleared on reflection
  });

  it("A_peer_probe_is_reflected_verbatim", () => {
    const clock = new FakeClock();
    const { engine, sent } = newEngine(clock, undefined);

    // A probe ORIGINATED BY THE PEER (its origin is the peer, not us) — we must
    // echo it back byte-for-byte, not treat it as a reflection / SNTT sample.
    const peerProbe = Inp3L3RttFrame.build(Peer);
    engine.onL3Rtt(Peer, peerProbe);

    expect(sent).toHaveLength(1); // a peer's probe is reflected back to it
    expect(sent[0]!.neighbour.equals(Peer)).toBe(true);
    expect(sent[0]!.frame).toBe(peerProbe); // reflection is verbatim — the same frame goes back unchanged
    expect(sent[0]!.frame.packet.network.origin.equals(Peer)).toBe(true); // verbatim echo keeps the peer as the origin

    expect(engine.snttMs(Peer)).toBeNull(); // reflecting a peer's probe is not a measurement of our own RTT
  });

  it("Capability_is_learned_from_a_peer_probe", () => {
    const clock = new FakeClock();
    const { engine } = newEngine(clock, undefined);

    // The peer probes us with $N and $I4 — we learn it speaks INP3 and accepts IPv4.
    const peerProbe = Inp3L3RttFrame.build(Peer, 4);
    expect(peerProbe.inp3Capable).toBe(true);
    expect(peerProbe.ipAccept).toBe(4);

    engine.onL3Rtt(Peer, peerProbe);

    expect(engine.neighbours).toHaveLength(1);
    const timing = engine.neighbours[0]!;
    expect(timing.inp3Capable).toBe(true); // a peer's $N probe proves it speaks INP3
    expect(timing.ipAccept).toBe(4); // its $I4 token advertises IPv4 acceptance
  });

  it("Reset_window_with_no_reflection_fires_NeighbourDown_for_a_capable_neighbour_and_resets_it", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
    };
    const { engine, sent } = newEngine(clock, opts);

    const downEvents: Inp3NeighbourDownEvent[] = [];
    engine.onNeighbourDown((e) => downEvents.push(e));

    // The peer proves it speaks INP3 (so the 180 s reset is allowed to raise
    // NeighbourDown — the AMBIGUITY-I2-3 guard).
    engine.onL3Rtt(Peer, Inp3L3RttFrame.build(Peer));
    expect(engine.neighbours).toHaveLength(1);
    expect(engine.neighbours[0]!.inp3Capable).toBe(true);
    sent.length = 0; // discard the reflection we sent

    // It then goes silent. Probes keep firing but nothing reflects. Just under the
    // window → no reset yet.
    clock.advance(179_000);
    engine.tick();
    expect(downEvents).toHaveLength(0); // 179 s of silence is within the 180 s reset window
    expect(engine.neighbours).toHaveLength(1); // the neighbour is still tracked

    // Past the window → NeighbourDown fires and the state is reset (removed).
    clock.advance(2_000); // t = 181 s of silence
    engine.tick();

    expect(downEvents).toHaveLength(1); // an INP3-capable neighbour that went silent raises NeighbourDown
    expect(downEvents[0]!.neighbour.equals(Peer)).toBe(true);
    expect(downEvents[0]!.silentForMs).toBeGreaterThanOrEqual(180_000); // silent at least the reset window

    expect(engine.neighbours).toHaveLength(0); // the neighbour's INP3 state is reset (removed) on teardown
    expect(engine.snttMs(Peer)).toBeNull(); // a reset neighbour has no SNTT
  });

  it("A_never_capable_vanilla_neighbour_is_dropped_silently_without_NeighbourDown", () => {
    // The AMBIGUITY-I2-3 guard: a neighbour that never reflects our optimistic
    // probes (never proven INP3-capable) must NOT trigger a routing teardown — it
    // is reachable by vanilla NODES, it just doesn't speak L3RTT. After the reset
    // window it is dropped from probing silently, no callback.
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
      probeUnknownCapability: true,
    };
    const { engine, sent } = newEngine(clock, opts);

    const downEvents: Inp3NeighbourDownEvent[] = [];
    engine.onNeighbourDown((e) => downEvents.push(e));

    engine.observeNeighbour(Peer);
    engine.tick(); // optimistic probe fires (capability unknown)
    expect(sent).toHaveLength(1); // ProbeUnknownCapability probes a not-yet-known neighbour
    expect(engine.neighbours).toHaveLength(1);
    expect(engine.neighbours[0]!.inp3Capable).toBe(false);

    // It never reflects. Past the reset window it is dropped — silently.
    clock.advance(181_000);
    engine.tick();

    expect(downEvents).toHaveLength(0); // a never-capable vanilla neighbour is never markNeighbourDown'd
    expect(engine.neighbours).toHaveLength(0); // but it is dropped so we don't probe a vanilla peer forever
  });

  it("Conservative_policy_does_not_probe_an_unknown_capability_neighbour", () => {
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
      probeUnknownCapability: false,
    };
    const { engine, sent } = newEngine(clock, opts);

    engine.observeNeighbour(Peer);
    engine.tick();
    expect(sent).toHaveLength(0); // with probeUnknownCapability=false we wait to be probed first

    // Once the peer probes us (proving capability), we start probing it.
    engine.onL3Rtt(Peer, Inp3L3RttFrame.build(Peer));
    sent.length = 0; // discard the reflection
    engine.tick();
    expect(sent).toHaveLength(1); // a now-known-capable neighbour is probed
  });

  it("Reflection_smoothing_follows_the_one_eighth_gain_IIR", () => {
    // Drive a sequence of reflections and assert the SNTT trajectory matches the
    // design §0.5 Example C (steady 200 ms RTT with one 2000 ms spike): the first
    // sample seeds, then SNTT' = (7*SNTT + sample + 4)/8.
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 600_000,
    };
    const { engine, sent } = newEngine(clock, opts);
    engine.observeNeighbour(Peer);

    // RTT in ms for each probe; sample = RTT/2. Expected SNTT after each.
    const steps: Array<{ rttMs: number; expectedSntt: number }> = [
      { rttMs: 200, expectedSntt: 100 }, // seed = 100
      { rttMs: 200, expectedSntt: 100 }, // (7*100+100+4)/8 = 100
      { rttMs: 2000, expectedSntt: 213 }, // (7*100+1000+4)/8 = 213  (the spike)
      { rttMs: 200, expectedSntt: 199 }, // (7*213+100+4)/8 = 199
      { rttMs: 200, expectedSntt: 187 }, // (7*199+100+4)/8 = 187   (walking the outlier back)
    ];

    for (const { rttMs, expectedSntt } of steps) {
      engine.tick(); // emit a probe (cadence has elapsed each loop)
      const probe = sent[sent.length - 1]!.frame;
      clock.advance(rttMs);
      engine.onL3Rtt(Peer, probe);
      expect(engine.snttMs(Peer)).toBe(expectedSntt); // RTT rttMs ms ⇒ sample rttMs/2 smoothed
      // Advance past the cadence so the next loop's tick probes again.
      clock.advance(60_000);
    }
  });

  it("OnL3Rtt_with_a_non_L3RTT_packet_returns_false_and_does_nothing", () => {
    const clock = new FakeClock();
    const { engine, sent } = newEngine(clock, undefined);

    const notL3Rtt: NetRomPacket = {
      network: { origin: Peer, destination: Local, timeToLive: 10 },
      transport: {
        circuitIndex: 1,
        circuitId: 1,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.Information,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array([1, 2, 3]),
    };

    expect(engine.onL3Rtt(Peer, notL3Rtt)).toBe(false); // a non-L3RTT packet is not ours to handle
    expect(sent).toHaveLength(0);
    expect(engine.neighbours).toHaveLength(0); // a non-L3RTT packet creates no neighbour state
  });

  it("RemoveNeighbour_inside_a_NeighbourDown_handler_is_safe", () => {
    // The callback fires outside the snapshot loop; a handler that re-enters the
    // engine (removeNeighbour for the same neighbour, already removed) must not
    // corrupt the iteration or throw.
    const clock = new FakeClock();
    const opts: Inp3Options = {
      l3RttIntervalMs: 60_000,
      l3RttResetWindowMs: 180_000,
    };
    const { engine } = newEngine(clock, opts);

    engine.onNeighbourDown((e) => engine.removeNeighbour(e.neighbour));

    engine.onL3Rtt(Peer, Inp3L3RttFrame.build(Peer)); // capable

    clock.advance(181_000);
    expect(() => engine.tick()).not.toThrow();
    expect(engine.neighbours).toHaveLength(0);
  });
});
