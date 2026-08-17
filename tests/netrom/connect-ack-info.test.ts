/**
 * Codec tests for the NET/ROM L4 Connect Acknowledge info field (the
 * accepted-window octet). TS counterpart of the `ConnectAckInfo` assertions in
 * `tests/Packet.NetRom.Tests/Transport/NetRomCircuitTests.cs` /
 * `NetRomCompressionTests.cs`, minus the compression half (this library has no
 * compression option, so it never builds or reads the BPQ TTL octet).
 */
import { describe, expect, it } from "vitest";
import {
  buildConnectAckInfo,
  CONNECT_ACK_INFO_VANILLA_LENGTH,
  CONNECT_ACK_MAX_WINDOW,
  tryReadAcceptedWindow,
} from "../../src/netrom/index.js";

describe("connect-ack info field", () => {
  it("builds the vanilla one-octet accepted-window field", () => {
    const info = buildConnectAckInfo(4);
    expect(info).toHaveLength(CONNECT_ACK_INFO_VANILLA_LENGTH);
    expect(info[0]).toBe(4);
  });

  it("clamps the built octet to 1..127", () => {
    expect(buildConnectAckInfo(0)[0]).toBe(1);
    expect(buildConnectAckInfo(-5)[0]).toBe(1);
    expect(buildConnectAckInfo(200)[0]).toBe(CONNECT_ACK_MAX_WINDOW);
  });

  it("reads back a window it built", () => {
    expect(tryReadAcceptedWindow(buildConnectAckInfo(7))).toBe(7);
    expect(tryReadAcceptedWindow(buildConnectAckInfo(127))).toBe(127);
  });

  it("returns null for an absent info field", () => {
    // A terse peer's bare 20-byte acknowledgement: nothing to read, so the
    // originator keeps the window it proposed.
    expect(tryReadAcceptedWindow(new Uint8Array(0))).toBeNull();
  });

  it("returns null for an out-of-range octet", () => {
    expect(tryReadAcceptedWindow(Uint8Array.from([0]))).toBeNull();
    expect(tryReadAcceptedWindow(Uint8Array.from([128]))).toBeNull();
    expect(tryReadAcceptedWindow(Uint8Array.from([255]))).toBeNull();
  });

  it("tolerates a longer field, reading only the first octet", () => {
    // A BPQ peer appends its TTL/compression octet; we ignore it and still
    // negotiate the window.
    expect(tryReadAcceptedWindow(Uint8Array.from([3, 0x99]))).toBe(3);
  });
});
