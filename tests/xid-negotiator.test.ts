/**
 * Unit tests for the §6.3.2 reverts-to merge and the §1436 version-2.0 default
 * set ({@link applyNegotiated} / {@link applyVersion20Defaults}) — the
 * substantive logic of the MDL "Apply Negotiated Parameters" placeholder,
 * pinned per parameter without the harness. The TS parity leg of packet.net's
 * `XidNegotiatorTests` (m0lte/packet.net#271, v2.2 arc V3 part 2).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "../src/sdl/session-context.js";
import {
  applyNegotiated,
  applyVersion20Defaults,
} from "../src/sdl/xid-negotiator.js";
import {
  HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
  octetsToBits,
  type XidParameters,
} from "../src/xid.js";

function newContext(): Ax25SessionContext {
  return createSessionContext(Callsign.parse("M0AAA"), Callsign.parse("M0BBB"));
}

describe("XidNegotiator — §6.3.2 reverts-to merge", () => {
  // ─── HDLC Optional Functions: lesser of reject + modulo (§6.3.2 ¶1426) ──

  it.each([
    // ours, theirs, expected agreed selective-reject
    [true, true, true], // both SREJ → SREJ
    [true, false, false], // one REJ → REJ (lesser)
    [false, true, false], // one REJ → REJ (lesser)
    [false, false, false], // both REJ → REJ
  ])(
    "reject scheme is the lesser of the two offers (ours=%s theirs=%s → SREJ=%s)",
    (oursSrej, theirsSrej, expectSrej) => {
      const ctx = newContext();
      const offered: XidParameters = {
        hdlcOptionalFunctions: {
          reject: oursSrej ? "selective" : "implicit",
          modulo128: true,
          srejMultiframe: false,
          segmenterReassembler: false,
        },
      };
      const response: XidParameters = {
        hdlcOptionalFunctions: {
          reject: theirsSrej ? "selective" : "implicit",
          modulo128: true,
          srejMultiframe: false,
          segmenterReassembler: false,
        },
      };

      applyNegotiated(ctx, offered, response);

      expect(ctx.srejEnabled).toBe(expectSrej);
      expect(ctx.implicitReject).toBe(!expectSrej);
    },
  );

  it.each([
    [true, true, true], // both mod-128 → mod-128
    [true, false, false], // one mod-8 → mod-8 (lesser)
    [false, true, false],
    [false, false, false],
  ])(
    "modulo is the lesser of the two offers (ours=%s theirs=%s → mod128=%s)",
    (oursMod128, theirsMod128, expectMod128) => {
      const ctx = newContext();
      const offered: XidParameters = {
        hdlcOptionalFunctions: {
          reject: "selective",
          modulo128: oursMod128,
          srejMultiframe: false,
          segmenterReassembler: false,
        },
      };
      const response: XidParameters = {
        hdlcOptionalFunctions: {
          reject: "selective",
          modulo128: theirsMod128,
          srejMultiframe: false,
          segmenterReassembler: false,
        },
      };

      applyNegotiated(ctx, offered, response);

      expect(ctx.isExtended).toBe(expectMod128);
    },
  );

  it("segmenter enabled only when both sides advertise it", () => {
    const bothOn: XidParameters = {
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: true,
        srejMultiframe: false,
        segmenterReassembler: true,
      },
    };
    const oneOff: XidParameters = {
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: true,
        srejMultiframe: false,
        segmenterReassembler: false,
      },
    };

    const ctx1 = newContext();
    applyNegotiated(ctx1, bothOn, bothOn);
    expect(ctx1.segmenterReassemblerEnabled).toBe(true);

    const ctx2 = newContext();
    applyNegotiated(ctx2, bothOn, oneOff);
    expect(ctx2.segmenterReassemblerEnabled).toBe(false);
  });

  // ─── Window k + N1: notification/min (§6.3.2 ¶1430 / ¶1428) ─────────────

  it("window k is the min of the two advertised", () => {
    const ctx = newContext();
    applyNegotiated(ctx, { windowSizeRx: 32 }, { windowSizeRx: 10 });
    expect(ctx.k).toBe(10);
  });

  it("N1 is the min of the two advertised octet lengths", () => {
    const ctx = newContext();
    applyNegotiated(
      ctx,
      { iFieldLengthRxBits: octetsToBits(256) },
      { iFieldLengthRxBits: octetsToBits(128) },
    );
    expect(ctx.n1).toBe(128); // N1 reverts to the min (the peer's smaller Rx capacity)
  });

  // ─── T1 + N2: greater (§6.3.2 ¶1432 / ¶1434) ────────────────────────────

  it("T1 is the greater of the two offers", () => {
    const ctx = newContext();
    applyNegotiated(ctx, { ackTimerMillis: 1000 }, { ackTimerMillis: 4000 });
    expect(ctx.t1vMs).toBe(4000);
  });

  it("N2 is the greater of the two offers", () => {
    const ctx = newContext();
    applyNegotiated(ctx, { retries: 8 }, { retries: 20 });
    expect(ctx.n2).toBe(20);
  });

  // ─── Absent fields retain current values (§4.3.3.7 ¶1024) ───────────────

  it("absent notification fields retain the current context values", () => {
    const ctx = newContext();
    ctx.k = 5;
    ctx.n1 = 200;
    ctx.n2 = 7;
    ctx.t1vMs = 1234;

    // Neither side offers k / N1 / T1 / N2 (only HDLC Optional Functions).
    const offered: XidParameters = {
      hdlcOptionalFunctions: HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
    };
    applyNegotiated(ctx, offered, offered);

    expect(ctx.k).toBe(5); // k absent from both offers ⇒ retain current
    expect(ctx.n1).toBe(200);
    expect(ctx.n2).toBe(7);
    expect(ctx.t1vMs).toBe(1234);
  });

  it("absent HDLC optional functions selects the v2.2 defaults", () => {
    // §6.3.2 ¶1426: if PI=3 absent from both, default SREJ + mod-128.
    const ctx = newContext();
    const empty: XidParameters = {};
    applyNegotiated(ctx, empty, empty);
    expect(ctx.srejEnabled).toBe(true); // default selective reject
    expect(ctx.isExtended).toBe(true); // default modulo 128
  });
});

describe("XidNegotiator — §1436 full version-2.0 default set", () => {
  it("version-2.0 defaults install the complete §1436 set", () => {
    const ctx = newContext();
    // Pre-load with v2.2-ish values so we can see them all replaced.
    ctx.isExtended = true;
    ctx.srejEnabled = true;
    ctx.segmenterReassemblerEnabled = true;
    ctx.k = 32;
    ctx.n1 = 512;
    ctx.n2 = 20;
    ctx.halfDuplex = false;
    ctx.t1vMs = 500;

    applyVersion20Defaults(ctx);

    expect(ctx.halfDuplex).toBe(true); // Set Half Duplex
    expect(ctx.implicitReject).toBe(true); // Set Implicit Reject
    expect(ctx.srejEnabled).toBe(false);
    expect(ctx.isExtended).toBe(false); // Modulo = 8
    expect(ctx.n1).toBe(256); // I Field Length Receive = 2048 bits = 256 octets
    expect(ctx.k).toBe(7); // Window Size Receive = 7 (NB: 7, not the mod-8 XID default 4)
    expect(ctx.t1vMs).toBe(3000); // Acknowledge Timer = 3000 ms
    expect(ctx.n2).toBe(10); // Retries = 10
    expect(ctx.segmenterReassemblerEnabled).toBe(false); // v2.2-only capability
  });
});
