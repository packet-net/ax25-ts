/**
 * Round-trip + totality tests for the NET/ROM L4 transport header (5 B) and the
 * Connect Request info field (15 B) — TS port of the transport-header / connect-
 * request cases in `tests/Packet.NetRom.Tests/Wire/NetRomHeaderCodecTests.cs`.
 *
 * (The C# suite also covers the L3 NetRomNetworkHeader + NetRomPacket; those
 * belong to a later slice and are not ported here — this slice ships the L4 +
 * origination wire codecs only.)
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  buildConnectRequestInfo,
  CONNECT_REQUEST_INFO_LENGTH,
  encodeTransportHeader,
  FLAGS_MASK,
  NetRomOpcode,
  NetRomTransportFlags,
  OPCODE_MASK,
  TRANSPORT_HEADER_ENCODED_LENGTH,
  transportHeaderChoke,
  transportHeaderMoreFollows,
  transportHeaderNak,
  transportHeaderOpcodeAndFlags,
  tryParseConnectRequestInfo,
  tryParseTransportHeader,
  writeTransportHeader,
  type NetRomTransportHeader,
} from "../../src/netrom/index.js";

describe("NetRomTransportHeader — round-trip per opcode + flags", () => {
  // Mirrors the C# [Theory] InlineData rows.
  const cases: ReadonlyArray<[number, number, string]> = [
    [NetRomOpcode.ConnectRequest, NetRomTransportFlags.None, "ConnectRequest/None"],
    [NetRomOpcode.Information, NetRomTransportFlags.MoreFollows, "Information/MoreFollows"],
    [
      NetRomOpcode.InformationAcknowledge,
      NetRomTransportFlags.Nak,
      "InformationAcknowledge/Nak",
    ],
    [NetRomOpcode.ConnectAcknowledge, NetRomTransportFlags.Choke, "ConnectAcknowledge/Choke"],
    [
      NetRomOpcode.Information,
      NetRomTransportFlags.Choke | NetRomTransportFlags.MoreFollows,
      "Information/Choke|MoreFollows",
    ],
  ];

  it.each(cases)(
    "round-trips opcode+flags (%s)",
    (opcode, flags) => {
      const header: NetRomTransportHeader = {
        circuitIndex: 7,
        circuitId: 42,
        txSequence: 3,
        rxSequence: 9,
        opcode,
        flags,
      };

      const bytes = encodeTransportHeader(header);
      expect(bytes.length).toBe(5);
      expect(bytes.length).toBe(TRANSPORT_HEADER_ENCODED_LENGTH);

      const parsed = tryParseTransportHeader(bytes);
      expect(parsed).not.toBeNull();
      expect(parsed!.circuitIndex).toBe(7);
      expect(parsed!.circuitId).toBe(42);
      expect(parsed!.txSequence).toBe(3);
      expect(parsed!.rxSequence).toBe(9);
      expect(parsed!.opcode).toBe(opcode);
      expect(parsed!.flags).toBe(flags);
    },
  );

  it("covers every opcode value through a full round-trip", () => {
    for (const opcode of Object.values(NetRomOpcode)) {
      const header: NetRomTransportHeader = {
        circuitIndex: 1,
        circuitId: 2,
        txSequence: 0,
        rxSequence: 0,
        opcode,
        flags: NetRomTransportFlags.None,
      };
      const parsed = tryParseTransportHeader(encodeTransportHeader(header));
      expect(parsed!.opcode).toBe(opcode);
    }
  });
});

describe("NetRomTransportHeader — flag helpers + opcode/flags masking", () => {
  it("flag helpers reflect the high bits", () => {
    // Mirrors C# Transport_flag_helpers_reflect_the_high_bits.
    const header: NetRomTransportHeader = {
      circuitIndex: 0,
      circuitId: 0,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.Information,
      flags: NetRomTransportFlags.Choke | NetRomTransportFlags.Nak,
    };
    expect(transportHeaderChoke(header)).toBe(true);
    expect(transportHeaderNak(header)).toBe(true);
    expect(transportHeaderMoreFollows(header)).toBe(false);
    // The opcode nibble and the flag bits coexist in one byte.
    expect(transportHeaderOpcodeAndFlags(header)).toBe(0x05 | 0x80 | 0x40);
  });

  it("packs the opcode in the low nibble and flags in the high nibble", () => {
    const header: NetRomTransportHeader = {
      circuitIndex: 0,
      circuitId: 0,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.InformationAcknowledge, // 0x06
      flags: NetRomTransportFlags.Choke, // 0x80
    };
    const opByte = encodeTransportHeader(header)[4]!;
    expect(opByte).toBe(0x86);
    expect(opByte & OPCODE_MASK).toBe(NetRomOpcode.InformationAcknowledge);
    expect(opByte & FLAGS_MASK).toBe(NetRomTransportFlags.Choke);
  });

  it("masking splits a raw opcode-and-flags byte back into opcode + flags", () => {
    // 0xF5 = opcode 0x05 (Information) | all three flag bits 0xF0.
    const bytes = Uint8Array.from([1, 2, 3, 4, 0xf5]);
    const parsed = tryParseTransportHeader(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.opcode).toBe(NetRomOpcode.Information);
    expect(parsed!.flags).toBe(0xf0);
    expect(transportHeaderChoke(parsed!)).toBe(true);
    expect(transportHeaderNak(parsed!)).toBe(true);
    expect(transportHeaderMoreFollows(parsed!)).toBe(true);
  });

  it("surfaces an unknown opcode nibble as its raw value (parse is total)", () => {
    // 0x0F is not a defined opcode; it must still parse, exposed for the circuit
    // layer to reject (mirrors the C# "any opcode-nibble value parses").
    const bytes = Uint8Array.from([0, 0, 0, 0, 0x0f]);
    const parsed = tryParseTransportHeader(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.opcode).toBe(0x0f);
    expect(parsed!.flags).toBe(0x00);
  });
});

describe("NetRomTransportHeader — parse totality + write-into-buffer", () => {
  it("returns null on short input without throwing", () => {
    expect(tryParseTransportHeader(new Uint8Array(0))).toBeNull();
    expect(tryParseTransportHeader(new Uint8Array(4))).toBeNull();
    expect(() => tryParseTransportHeader(new Uint8Array(0))).not.toThrow();
  });

  it("writes into a buffer at an offset, leaving surrounding bytes intact", () => {
    const header: NetRomTransportHeader = {
      circuitIndex: 0x11,
      circuitId: 0x22,
      txSequence: 0x33,
      rxSequence: 0x44,
      opcode: NetRomOpcode.ConnectRequest,
      flags: NetRomTransportFlags.None,
    };
    const buf = new Uint8Array(8).fill(0xee);
    writeTransportHeader(header, buf, 2);
    expect(buf[0]).toBe(0xee);
    expect(buf[1]).toBe(0xee);
    expect(Array.from(buf.slice(2, 7))).toEqual([0x11, 0x22, 0x33, 0x44, 0x01]);
    expect(buf[7]).toBe(0xee);
    // And it parses back from that offset.
    const parsed = tryParseTransportHeader(buf, 2);
    expect(parsed!.circuitIndex).toBe(0x11);
    expect(parsed!.opcode).toBe(NetRomOpcode.ConnectRequest);
  });

  it("throws if the destination buffer is too short", () => {
    const header: NetRomTransportHeader = {
      circuitIndex: 0,
      circuitId: 0,
      txSequence: 0,
      rxSequence: 0,
      opcode: NetRomOpcode.Information,
      flags: NetRomTransportFlags.None,
    };
    expect(() => writeTransportHeader(header, new Uint8Array(4))).toThrow();
  });
});

describe("ConnectRequestInfo — build/parse round-trip + tolerance", () => {
  it("round-trips window, user and node", () => {
    // Mirrors C# ConnectRequest_info_round_trips_window_user_and_node.
    const user = new Callsign("M0LTE", 7);
    const node = new Callsign("GB7RDG", 0);

    const info = buildConnectRequestInfo(6, user, node);
    expect(info.length).toBe(CONNECT_REQUEST_INFO_LENGTH);
    expect(info.length).toBe(15); // window byte + two shifted callsigns
    // The proposed window is the FIRST info octet, not a transport-header field.
    expect(info[0]).toBe(6);

    const parsed = tryParseConnectRequestInfo(info);
    expect(parsed).not.toBeNull();
    expect(parsed!.proposedWindow).toBe(6);
    expect(parsed!.originatingUser.equals(user)).toBe(true);
    expect(parsed!.originatingNode.equals(node)).toBe(true);
  });

  it("tolerates trailing extension octets (the LinBPQ form)", () => {
    // LinBPQ 6.0.25.23 originates a 17-octet Connect Request info field (verified
    // via the interop stack, #308): [window][user][node] then a 2-octet BPQ
    // extension. We parse the canonical 15 and ignore the rest. These exact bytes
    // are a real PN0TST->PNPROB Connect Request: window 4, user + node both
    // PN0TST, trailing 0x3C 0x00.
    const bpqOnTheWire = Uint8Array.from([
      0x04, // proposed window = 4
      0xa0, 0x9c, 0x60, 0xa8, 0xa6, 0xa8, 0x60, // originating user = PN0TST
      0xa0, 0x9c, 0x60, 0xa8, 0xa6, 0xa8, 0x60, // originating node = PN0TST
      0x3c, 0x00, // BPQ extension (ignored)
    ]);

    const parsed = tryParseConnectRequestInfo(bpqOnTheWire);
    expect(parsed).not.toBeNull();
    expect(parsed!.proposedWindow).toBe(4);
    expect(parsed!.originatingUser.equals(new Callsign("PN0TST", 0))).toBe(true);
    expect(parsed!.originatingNode.equals(new Callsign("PN0TST", 0))).toBe(true);
  });

  it("returns null on short input (the field is 15 octets)", () => {
    // Mirrors C# ConnectRequest_info_parse_is_total_on_short_input.
    expect(tryParseConnectRequestInfo(new Uint8Array(14))).toBeNull();
    expect(tryParseConnectRequestInfo(new Uint8Array(0))).toBeNull();
    expect(() => tryParseConnectRequestInfo(new Uint8Array(0))).not.toThrow();
  });

  it("preserves the originating-node SSID across the shifted round-trip", () => {
    const user = new Callsign("M0LTE", 0);
    const node = new Callsign("GB7RDG", 12);
    const parsed = tryParseConnectRequestInfo(
      buildConnectRequestInfo(127, user, node),
    );
    expect(parsed!.originatingNode.ssid).toBe(12);
    expect(parsed!.proposedWindow).toBe(127);
  });
});
