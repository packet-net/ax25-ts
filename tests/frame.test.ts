import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  classify,
  decodeFrame,
  disc,
  dm,
  encodeFrame,
  frmr,
  getNr,
  getNs,
  iFrame,
  isCommand,
  isResponse,
  pollFinal,
  rej,
  rr,
  sabm,
  srej,
  ua,
  ui,
  xid,
} from "../src/frame.js";

describe("frame codec — U frames", () => {
  it("builds and round-trips a SABM command", () => {
    const f = sabm({
      destination: Callsign.parse("GB7CIP"),
      source: Callsign.parse("M0LTE-2"),
    });
    expect(classify(f)).toBe("SABM");
    expect(isCommand(f)).toBe(true);
    expect(pollFinal(f)).toBe(true);
    const bytes = encodeFrame(f);
    const round = decodeFrame(bytes);
    expect(classify(round)).toBe("SABM");
    expect(round.source.callsign.toString()).toBe("M0LTE-2");
    expect(round.destination.callsign.toString()).toBe("GB7CIP");
  });

  it("builds and round-trips a UA response", () => {
    const f = ua({
      destination: Callsign.parse("M0LTE-2"),
      source: Callsign.parse("GB7CIP"),
    });
    expect(classify(f)).toBe("UA");
    expect(isResponse(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("UA");
  });

  it("builds a DISC and a DM that classify correctly", () => {
    const d = disc({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(classify(d)).toBe("DISC");
    const dmf = dm({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(classify(dmf)).toBe("DM");
    expect(isResponse(dmf)).toBe(true);
  });

  it("builds a UI frame with the configured PID and payload", () => {
    const f = ui({
      destination: Callsign.parse("APRS"),
      source: Callsign.parse("M0LTE-9"),
      info: new TextEncoder().encode(">test"),
    });
    expect(classify(f)).toBe("UI");
    expect(f.pid).toBe(0xf0);
    const round = decodeFrame(encodeFrame(f));
    expect(round.pid).toBe(0xf0);
    expect(new TextDecoder().decode(round.info)).toBe(">test");
  });

  it("builds an XID command/response carrying an info field (no PID), round-trips", () => {
    const info = Uint8Array.from([0x82, 0x80, 0x00, 0x00]);
    const cmd = xid({
      destination: Callsign.parse("M0BBB"),
      source: Callsign.parse("M0AAA"),
      info,
      isCommand: true,
      pollFinal: true,
    });
    expect(classify(cmd)).toBe("XID");
    expect(isCommand(cmd)).toBe(true);
    expect(pollFinal(cmd)).toBe(true);
    expect(cmd.pid).toBeNull(); // XID carries no PID (§3.5)
    const cmdRound = decodeFrame(encodeFrame(cmd));
    expect(classify(cmdRound)).toBe("XID");
    expect(cmdRound.pid).toBeNull();
    expect([...cmdRound.info]).toEqual([...info]);

    const resp = xid({
      destination: Callsign.parse("M0BBB"),
      source: Callsign.parse("M0AAA"),
      info,
      isCommand: false,
      pollFinal: true,
    });
    expect(classify(resp)).toBe("XID");
    expect(isResponse(resp)).toBe(true);
    expect(pollFinal(resp)).toBe(true);
  });

  it("builds a FRMR response with a 3-octet cause field, round-trips", () => {
    const cause = Uint8Array.from([0x01, 0x02, 0x03]);
    const f = frmr({
      destination: Callsign.parse("M0BBB"),
      source: Callsign.parse("M0AAA"),
      info: cause,
    });
    expect(classify(f)).toBe("FRMR");
    expect(isResponse(f)).toBe(true); // FRMR is response-only
    expect(f.pid).toBeNull();
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("FRMR");
    expect([...round.info]).toEqual([...cause]);
  });
});

describe("frame codec — S frames", () => {
  it("builds RR with the correct N(R) and PF bits", () => {
    const f = rr({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 5,
      isCommand: false,
      pollFinal: true,
    });
    expect(classify(f)).toBe("RR");
    expect(getNr(f)).toBe(5);
    expect(pollFinal(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("RR");
    expect(getNr(round)).toBe(5);
  });

  it("builds SREJ with the correct N(R) and F bit, classifies distinctly from REJ", () => {
    const f = srej({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 3,
      isCommand: false,
      pollFinal: true,
    });
    // SREJ control base is 0x0D — distinct from REJ's 0x09; classify must not
    // confuse the two (the §4.3.2.4 selective reject vs §4.3.2.3 reject).
    expect(classify(f)).toBe("SREJ");
    expect(getNr(f)).toBe(3);
    expect(pollFinal(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("SREJ");
    expect(getNr(round)).toBe(3);

    // A REJ with the same N(R) must classify as REJ, not SREJ — guards the
    // control-byte bit discrimination both ways.
    const r = rej({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 3,
      isCommand: false,
    });
    expect(classify(r)).toBe("REJ");
    expect(classify(decodeFrame(encodeFrame(r)))).toBe("REJ");
  });
});

describe("frame codec — I frames", () => {
  it("encodes N(R), N(S), P, PID, info", () => {
    const f = iFrame({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 3,
      ns: 2,
      info: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      pollBit: true,
    });
    expect(classify(f)).toBe("I");
    expect(getNs(f)).toBe(2);
    expect(getNr(f)).toBe(3);
    expect(pollFinal(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("I");
    expect(getNs(round)).toBe(2);
    expect(getNr(round)).toBe(3);
    expect(Array.from(round.info)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("rejects frames whose first address fields are broken", () => {
    // 14 bytes of zeros = malformed (E-bit clear past offset, etc.)
    const bad = new Uint8Array(15);
    expect(() => decodeFrame(bad)).toThrow();
  });
});

describe("frame factories with digipeaters", () => {
  it("sets the E-bit on the last digipeater, not on source", () => {
    const f = sabm({
      destination: Callsign.parse("GB7CIP"),
      source: Callsign.parse("M0LTE-2"),
      digipeaters: [Callsign.parse("G8BPQ"), Callsign.parse("M5XYZ-1")],
    });
    expect(f.source.extensionBit).toBe(false);
    expect(f.digipeaters[0]!.extensionBit).toBe(false);
    expect(f.digipeaters[1]!.extensionBit).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(round.digipeaters.length).toBe(2);
    expect(round.digipeaters[0]!.callsign.toString()).toBe("G8BPQ");
    expect(round.digipeaters[1]!.callsign.toString()).toBe("M5XYZ-1");
  });

  it("sets the E-bit on the source slot when no digipeaters", () => {
    const f = sabm({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(f.source.extensionBit).toBe(true);
  });
});
