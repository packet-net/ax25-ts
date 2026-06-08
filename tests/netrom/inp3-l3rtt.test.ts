/**
 * Round-trip, spec hex-vector, recognition, and totality tests for the INP3
 * L3RTT codec ({@link Inp3L3RttFrame}). Vectors are taken verbatim from
 * `docs/netrom-inp3-i1-wire-spec.md` §1.5 and are shared cross-stack golden
 * vectors (the C# reference is authoritative; TS and Rust mirror it 1:1).
 *
 * TS port of `tests/Packet.NetRom.Tests/Wire/Inp3L3RttTests.cs`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  type NetRomPacket,
  NetRomOpcode,
  NetRomTransportFlags,
} from "../../src/netrom/index.js";
import { Inp3L3RttFrame } from "../../src/netrom/inp3-l3rtt.js";

const M0Lte = new Callsign("M0LTE", 0);

// From §1.5: origin M0LTE-0, dest L3RTT-0, TTL 0x19, transport 00 00 00 00 02.
const HeaderPrefix = Uint8Array.from([
  0x9a, 0x60, 0x98, 0xa8, 0x8a, 0x40, 0x60, // origin M0LTE-0
  0x98, 0x66, 0xa4, 0xa8, 0xa8, 0x40, 0x60, // dest L3RTT-0
  0x19, // TTL = 25
  0x00, 0x00, 0x00, 0x00, 0x02, // transport: opcode 0x02, no flags
]);

/** Concatenate the header prefix with the given payload bytes. */
function withPayload(...payload: number[]): Uint8Array {
  return Uint8Array.from([...HeaderPrefix, ...payload]);
}

// Vector L3RTT-A — probe advertising plain INP3 ("$N      "), length 28.
const VectorA = withPayload(
  0x24, 0x4e, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, // "$N" + 6 spaces
);

// Vector L3RTT-B — probe advertising INP3 + IPv4 ("$N$I4   "), length 28.
const VectorB = withPayload(
  0x24, 0x4e, 0x24, 0x49, 0x34, 0x20, 0x20, 0x20, // "$N$I4" + 3 spaces
);

// Vector L3RTT-C — reflection: byte-identical echo of Vector A.
const VectorC = VectorA;

describe("Inp3L3RttFrame — build + spec vectors", () => {
  it("Build_plain_inp3_probe_matches_spec_vector_A", () => {
    const frame = Inp3L3RttFrame.build(M0Lte);

    expect([...frame.toBytes()]).toEqual([...VectorA]);
    expect(frame.toBytes().length).toBe(28);
    expect(frame.inp3Capable).toBe(true);
    expect(frame.ipAccept).toBeNull();
    // default width 8: $N right-padded with six spaces
    expect(frame.capabilityText).toBe("$N      ");

    // The frame IS a NetRomPacket with the canonical L3RTT shape.
    expect(frame.packet.network.origin.equals(M0Lte)).toBe(true);
    expect(
      frame.packet.network.destination.equals(new Callsign("L3RTT", 0)),
    ).toBe(true);
    expect(frame.packet.network.timeToLive).toBe(25);
    expect(frame.packet.transport.opcode & 0x0f).toBe(0x02);
    expect(frame.packet.transport.flags).toBe(NetRomTransportFlags.None);
  });

  it("Build_inp3_plus_ipv4_probe_matches_spec_vector_B", () => {
    const frame = Inp3L3RttFrame.build(M0Lte, 4);

    expect([...frame.toBytes()]).toEqual([...VectorB]);
    expect(frame.toBytes().length).toBe(28);
    expect(frame.inp3Capable).toBe(true);
    expect(frame.ipAccept).toBe(4);
    expect(frame.capabilityText).toBe("$N$I4   ");
  });
});

describe("Inp3L3RttFrame — parse spec vectors", () => {
  it("Parse_vector_A_extracts_plain_inp3_capability", () => {
    const frame = Inp3L3RttFrame.tryParse(VectorA);
    expect(frame).not.toBeNull();
    expect(frame!.inp3Capable).toBe(true);
    expect(frame!.ipAccept).toBeNull();
    expect(frame!.packet.network.origin.equals(M0Lte)).toBe(true);
    expect(frame!.packet.network.destination.base).toBe("L3RTT");
  });

  it("Parse_vector_B_extracts_inp3_and_ipv4", () => {
    const frame = Inp3L3RttFrame.tryParse(VectorB);
    expect(frame).not.toBeNull();
    expect(frame!.inp3Capable).toBe(true);
    // the $I4 token advertises IPv4 acceptance
    expect(frame!.ipAccept).toBe(4);
  });

  it("Parse_vector_C_recognised_as_our_own_reflection_by_origin", () => {
    // Verbatim echo: a returning frame keeps the original prober's origin, so
    // the prober recognises its own probe by Origin == self (§1.4).
    const frame = Inp3L3RttFrame.tryParse(VectorC);
    expect(frame).not.toBeNull();
    // origin came back unchanged as M0LTE-0
    expect(frame!.isReflectionOf(M0Lte)).toBe(true);
    // a different node's probe is not ours
    expect(frame!.isReflectionOf(new Callsign("GB7RDG", 0))).toBe(false);
  });

  it("Build_then_parse_round_trips_through_bytes", () => {
    for (const ip of [undefined, 0, 4, 6, 9]) {
      const built = Inp3L3RttFrame.build(M0Lte, ip);
      const parsed = Inp3L3RttFrame.tryParse(built.toBytes());
      expect(parsed).not.toBeNull();
      expect(parsed!.inp3Capable).toBe(true);
      expect(parsed!.ipAccept).toBe(ip ?? null);
      expect(parsed!.packet.network.origin.equals(M0Lte)).toBe(true);
      expect([...parsed!.toBytes()]).toEqual([...built.toBytes()]);
    }
  });
});

describe("Inp3L3RttFrame — width-independent capability scan", () => {
  it("Capability_text_parse_is_width_independent", () => {
    // The recogniser scans $-tokens regardless of pad width / contiguity.
    const wide = Inp3L3RttFrame.build(M0Lte, 4, undefined, 40);
    // the payload was padded to the requested width
    expect(wide.toBytes().slice(20).length).toBe(40);
    const parsed = Inp3L3RttFrame.tryParse(wide.toBytes());
    expect(parsed).not.toBeNull();
    expect(parsed!.inp3Capable).toBe(true);
    expect(parsed!.ipAccept).toBe(4);
  });

  it("Capability_text_shorter_than_width_is_not_truncated", () => {
    // A width smaller than the tokens leaves them intact (no truncation, no pad).
    const frame = Inp3L3RttFrame.build(M0Lte, 4, undefined, 0);
    expect(frame.capabilityText).toBe("$N$I4");
    const parsed = Inp3L3RttFrame.tryParse(frame.toBytes());
    expect(parsed).not.toBeNull();
    expect(parsed!.inp3Capable).toBe(true);
    expect(parsed!.ipAccept).toBe(4);
  });

  it("Unknown_dollar_tokens_are_ignored_but_known_ones_still_parse", () => {
    // Forward-compat: an unknown $-capability between $N and $I4 must not break
    // recognition of the tokens we do understand.
    const packet: NetRomPacket = {
      network: {
        origin: M0Lte,
        destination: new Callsign("L3RTT", 0),
        timeToLive: 25,
      },
      transport: {
        circuitIndex: 0,
        circuitId: 0,
        txSequence: 0,
        rxSequence: 0,
        opcode: 0x02,
        flags: NetRomTransportFlags.None,
      },
      // "$N$Z9$I4 "
      payload: Uint8Array.from([
        0x24, 0x4e, 0x24, 0x5a, 0x39, 0x24, 0x49, 0x34, 0x20,
      ]),
    };

    const frame = Inp3L3RttFrame.tryFrom(packet);
    expect(frame).not.toBeNull();
    expect(frame!.inp3Capable).toBe(true);
    expect(frame!.ipAccept).toBe(4);
  });
});

describe("Inp3L3RttFrame — recognition discriminators", () => {
  it("A_packet_without_dollar_N_is_l3rtt_but_not_inp3_capable", () => {
    // Absence of $N means fall back to vanilla NODES (§1.3) — still an L3RTT
    // frame by destination+opcode, just not advertising INP3.
    const packet: NetRomPacket = {
      network: {
        origin: M0Lte,
        destination: new Callsign("L3RTT", 0),
        timeToLive: 25,
      },
      transport: {
        circuitIndex: 0,
        circuitId: 0,
        txSequence: 0,
        rxSequence: 0,
        opcode: 0x02,
        flags: NetRomTransportFlags.None,
      },
      // "        " (8 spaces)
      payload: Uint8Array.from([
        0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
      ]),
    };

    expect(Inp3L3RttFrame.isL3Rtt(packet)).toBe(true);
    const frame = Inp3L3RttFrame.tryFrom(packet);
    expect(frame).not.toBeNull();
    expect(frame!.inp3Capable).toBe(false);
    expect(frame!.ipAccept).toBeNull();
  });

  it("Non_l3rtt_destination_is_not_recognised", () => {
    // A real Connect Acknowledge (opcode 0x02) to a normal node must NOT be
    // mistaken for L3RTT — the destination is the discriminator, not the opcode.
    const connectAck: NetRomPacket = {
      network: {
        origin: M0Lte,
        destination: new Callsign("GB7RDG", 0),
        timeToLive: 25,
      },
      transport: {
        circuitIndex: 1,
        circuitId: 1,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.ConnectAcknowledge,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array(0),
    };

    // opcode 0x02 alone is not L3RTT
    expect(Inp3L3RttFrame.isL3Rtt(connectAck)).toBe(false);
    expect(Inp3L3RttFrame.tryFrom(connectAck)).toBeNull();
  });

  it("L3rtt_destination_with_wrong_opcode_is_not_recognised", () => {
    const packet: NetRomPacket = {
      network: {
        origin: M0Lte,
        destination: new Callsign("L3RTT", 0),
        timeToLive: 25,
      },
      transport: {
        circuitIndex: 0,
        circuitId: 0,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.Information,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array(0),
    };

    // opcode nibble must be 0x02
    expect(Inp3L3RttFrame.isL3Rtt(packet)).toBe(false);
    expect(Inp3L3RttFrame.tryFrom(packet)).toBeNull();
  });
});

describe("Inp3L3RttFrame — totality / fuzz", () => {
  it("Parse_is_total_on_empty_and_truncated_input", () => {
    expect(Inp3L3RttFrame.tryParse(new Uint8Array(0))).toBeNull();
    // a datagram needs the full 20-byte header
    expect(Inp3L3RttFrame.tryParse(new Uint8Array(19))).toBeNull();
    // an all-zero callsign slot is not a decodable callsign, so the packet
    // itself fails to parse
    expect(Inp3L3RttFrame.tryParse(new Uint8Array(20))).toBeNull();

    // Truncate Vector A at every length below full — none should throw or
    // succeed past the point the header decodes to a valid L3RTT packet.
    for (let len = 0; len < VectorA.length; len++) {
      // Must never throw.
      expect(() => Inp3L3RttFrame.tryParse(VectorA.slice(0, len))).not.toThrow();
    }

    // A header-only (payload-empty) L3RTT still parses: no $N → not capable.
    const headerOnly = Inp3L3RttFrame.tryParse(VectorA.slice(0, 20));
    expect(headerOnly).not.toBeNull();
    expect(headerOnly!.inp3Capable).toBe(false);
  });

  it("Parse_is_total_on_garbage", () => {
    // Deterministic LCG (the C# uses Random(20260607)); the contract is "never
    // throws", so the exact byte stream is incidental — only totality matters.
    let state = 20260607 >>> 0;
    const next = (): number => {
      // Numerical Recipes 32-bit LCG.
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let trial = 0; trial < 20000; trial++) {
      const buf = new Uint8Array(next() % 64);
      for (let i = 0; i < buf.length; i++) {
        buf[i] = next() & 0xff;
      }
      // The contract: never throws. Whether it recognises is incidental.
      expect(() => Inp3L3RttFrame.tryParse(buf)).not.toThrow();
    }
  });
});

describe("Inp3L3RttFrame — build validation + knobs", () => {
  it("Build_rejects_out_of_range_ip_accept", () => {
    // IP version must be a single decimal digit
    expect(() => Inp3L3RttFrame.build(M0Lte, 10)).toThrow();
    expect(() => Inp3L3RttFrame.build(M0Lte, -1)).toThrow();
  });

  it("Build_honours_custom_ttl", () => {
    const frame = Inp3L3RttFrame.build(M0Lte, undefined, 1);
    // any TTL >= 1 works for the single-hop probe
    expect(frame.packet.network.timeToLive).toBe(1);
  });
});
