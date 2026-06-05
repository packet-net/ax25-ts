/**
 * Round-trip + totality tests for the NET/ROM L3 network header (15 B) and the
 * full {@link NetRomPacket} datagram — the L3 wire foundation the circuit layer
 * rides on.
 *
 * TS port of the network-header + packet cases in
 * `tests/Packet.NetRom.Tests/Wire/NetRomHeaderCodecTests.cs` that TS-1 left out
 * (the transport-header + Connect Request cases live in transport-header.test.ts).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  decrementedNetworkHeader,
  encodeNetRomPacket,
  encodeNetworkHeader,
  type NetRomNetworkHeader,
  type NetRomPacket,
  NetRomOpcode,
  NetRomTransportFlags,
  NETWORK_HEADER_ENCODED_LENGTH,
  PACKET_HEADER_LENGTH,
  tryParseNetRomPacket,
  tryParseNetworkHeader,
} from "../../src/netrom/index.js";

const Origin = new Callsign("GB7RDG", 1);
const Dest = new Callsign("GB7SOT", 2);

describe("NetRomNetworkHeader — round-trip + totality", () => {
  it("Network_header_round_trips_through_bytes", () => {
    const header: NetRomNetworkHeader = {
      origin: Origin,
      destination: Dest,
      timeToLive: 25,
    };

    const bytes = encodeNetworkHeader(header);
    expect(bytes.length).toBe(NETWORK_HEADER_ENCODED_LENGTH);
    expect(bytes.length).toBe(15);

    const parsed = tryParseNetworkHeader(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.origin.equals(Origin)).toBe(true);
    expect(parsed!.destination.equals(Dest)).toBe(true);
    expect(parsed!.timeToLive).toBe(25);
  });

  it("Network_header_decrement_reduces_ttl_and_floors_at_zero", () => {
    const header: NetRomNetworkHeader = {
      origin: Origin,
      destination: Dest,
      timeToLive: 1,
    };
    expect(decrementedNetworkHeader(header).timeToLive).toBe(0);
    // TTL never underflows past zero
    expect(
      decrementedNetworkHeader(decrementedNetworkHeader(header)).timeToLive,
    ).toBe(0);
  });

  it("Network_header_parse_is_total_on_short_input", () => {
    expect(tryParseNetworkHeader(new Uint8Array(0))).toBeNull();
    expect(tryParseNetworkHeader(new Uint8Array(14))).toBeNull();
  });
});

describe("NetRomPacket — round-trip + totality", () => {
  it("Packet_round_trips_header_plus_payload", () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const packet: NetRomPacket = {
      network: { origin: Origin, destination: Dest, timeToLive: 20 },
      transport: {
        circuitIndex: 1,
        circuitId: 1,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.Information,
        flags: NetRomTransportFlags.None,
      },
      payload,
    };

    const bytes = encodeNetRomPacket(packet);
    expect(bytes.length).toBe(PACKET_HEADER_LENGTH + payload.length);
    expect(bytes.length).toBe(25);

    const parsed = tryParseNetRomPacket(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.network.origin.equals(Origin)).toBe(true);
    expect(parsed!.transport.opcode).toBe(NetRomOpcode.Information);
    expect([...parsed!.payload]).toEqual([...payload]);
  });

  it("Empty_control_packet_is_the_observed_20_byte_form", () => {
    // The repo's BPQ corpus saw PID-0xCF I-frames "always exactly 20 B" — the
    // 15-byte network + 5-byte transport header with no payload.
    const packet: NetRomPacket = {
      network: { origin: Origin, destination: Dest, timeToLive: 25 },
      transport: {
        circuitIndex: 1,
        circuitId: 1,
        txSequence: 0,
        rxSequence: 0,
        opcode: NetRomOpcode.ConnectRequest,
        flags: NetRomTransportFlags.None,
      },
      payload: new Uint8Array(0),
    };
    expect(encodeNetRomPacket(packet).length).toBe(20);
  });

  it("Packet_parse_is_total_on_short_input", () => {
    // a datagram needs the full 20-byte header
    expect(tryParseNetRomPacket(new Uint8Array(19))).toBeNull();
    expect(tryParseNetRomPacket(new Uint8Array(0))).toBeNull();
  });
});
