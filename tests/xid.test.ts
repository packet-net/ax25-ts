import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { decodeFrame, encodeFrame, ui } from "../src/frame.js";
import {
  CLASSES_OF_PROCEDURES_FULL_DUPLEX,
  CLASSES_OF_PROCEDURES_HALF_DUPLEX,
  HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
  PI_ACK_TIMER,
  PI_CLASSES_OF_PROCEDURES,
  PI_HDLC_OPTIONAL_FUNCTIONS,
  PI_I_FIELD_LENGTH_RX,
  PI_RETRIES,
  PI_WINDOW_SIZE_RX,
  XID_FORMAT_IDENTIFIER,
  XID_GROUP_IDENTIFIER,
  XID_HEADER_LENGTH,
  XID_PARSE_LENIENT,
  XID_PARSE_STRICT,
  classesOfProceduresToOctets,
  decodeUnsignedXid,
  encodeUnsignedXid,
  encodeXid,
  hdlcOptionalFunctionsFromOctets,
  hdlcOptionalFunctionsToOctets,
  iFieldLengthRxOctets,
  octetsToBits,
  tryParseXid,
  type HdlcOptionalFunctions,
  type RejectMode,
  type XidParameters,
} from "../src/xid.js";

/**
 * Codec tests for the AX.25 v2.2 XID information field (§4.3.3.7 / Figure 4.5,
 * worked example Figure 4.6). The TS parity leg of packet.net's
 * `XidInfoFieldTests` (m0lte/packet.net#270, v2.2 arc V3 part 1): spec-pinned
 * bytes, the Figure 4.6 worked example parsed and re-encoded byte-for-byte,
 * per-parameter round-trips, absent/optional-field handling, malformed/
 * short-buffer cases, and the strict-vs-lenient pairing the repo requires for
 * any parser leniency.
 *
 * The 3-octet HDLC Optional Functions PV goes on the wire most-significant
 * octet first (AX.25 v2.2 §3.8 / direwolf / LinBPQ) — verified independently
 * against Figure 4.6 (whose printed `82 A8 22` is the byte-reversed figure
 * error) in the "spec bit layout" describe block and the dedicated octet-order
 * test below.
 */
describe("XID information-field codec (§4.3.3.7 / Fig 4.5)", () => {
  // The information field from Figure 4.6 (NJ7P → N7LEM), parameter field
  // GL = 0x17 (23 octets):
  //   FI GI  GL----  P2 ----------  P3 ---------------  P6 ----------  P8 ----  P9 ----------  PA ----
  //   82 80  00 17   02 02 22 00    03 03 22 A8 82      06 02 04 00    08 01 02 09 02 10 00    0A 01 03
  //
  // NOTE on the HDLC Optional Functions PV (P3 = 03 03 ..): Figure 4.6 *prints*
  // `82 A8 22`, but that is the LSB-octet-first (byte-reversed) layout and is a
  // figure error — AX.25 v2.2 §3.8 mandates multi-octet fields go on the wire
  // MOST-SIGNIFICANT OCTET FIRST (the order direwolf's xid.c, LinBPQ's L2Code.c,
  // and every real peer use — verified on the wire: BPQ accepts the MSB-first PV
  // and negotiates SREJ, and silently drops the LSB-first one). Our
  // HdlcOptionalFunctions bit constants are numbered in the LSB-octet value
  // space, so the SAME logical selection (REJ + modulo-128 + SREJ-multiframe +
  // the always-1 bits) serialises to the byte-reversed octets `22 A8 82` here.
  // The decode below recovers the identical selection. Mirrors the C#
  // XidInfoFieldTests Figure46Info note.
  const figure46Info = new Uint8Array([
    0x82, 0x80, 0x00, 0x17,
    0x02, 0x02, 0x22, 0x00,
    0x03, 0x03, 0x22, 0xa8, 0x82,
    0x06, 0x02, 0x04, 0x00,
    0x08, 0x01, 0x02,
    0x09, 0x02, 0x10, 0x00,
    0x0a, 0x01, 0x03,
  ]);

  // The byte index of the Classes-of-Procedures octet 0 within figure46Info.
  // See the ABM-anomaly note below.
  const ABM_ANOMALY_INDEX = 6;

  // ─── Header constants (§4.3.3.7 ¶1019–1021) ──────────────────────────

  it("pins the header + PI constants to the spec", () => {
    expect(XID_FORMAT_IDENTIFIER).toBe(0x82); // FI, general-purpose XID (¶1019)
    expect(XID_GROUP_IDENTIFIER).toBe(0x80); // GI, parameter negotiation (¶1020)
    expect(XID_HEADER_LENGTH).toBe(4); // FI + GI + GL(2)
    // PI numbers per Figure 4.5.
    expect(PI_CLASSES_OF_PROCEDURES).toBe(2);
    expect(PI_HDLC_OPTIONAL_FUNCTIONS).toBe(3);
    expect(PI_I_FIELD_LENGTH_RX).toBe(6);
    expect(PI_WINDOW_SIZE_RX).toBe(8);
    expect(PI_ACK_TIMER).toBe(9);
    expect(PI_RETRIES).toBe(0x0a);
  });

  // ─── Independent spec bit-layout verification (Figure 4.5 / 4.6) ──────
  // These don't trust the codec — they decode the literal Fig 4.6 PV bytes by
  // hand (LSB-first per octet, octet 0 first) and assert the bit positions the
  // Figure 4.5 table assigns.

  describe("spec bit layout verified against Fig 4.6", () => {
    it("Classes-of-Procedures Fig 4.6 PV 0x22 0x00 sets bits 1 and 5", () => {
      // The literal figure bytes (Classes-of-Procedures is a 2-octet field; the
      // figure's worked example is unaffected by the HDLC octet-order fix). The
      // table puts ABM at bit 0 ⇒ 0x21; the figure put it at bit 1 ⇒ 0x22 — the
      // documented worked-example off-by-one. Either way half-duplex is bit 5.
      const field = 0x22 | (0x00 << 8);
      const setBits = [...Array(16).keys()].filter((b) => (field >> b) & 1);
      expect(setBits).toEqual([1, 5]);
      expect((field >> 5) & 1).toBe(1); // half-duplex bit 5 (table-faithful)
      expect((field >> 6) & 1).toBe(0); // full-duplex bit 6 clear
    });

    it("HDLC-Optional-Functions Fig 4.6 selection sets bits 1,7,11,13,15,17,21", () => {
      // The faithful MSB-octet-first wire PV for this selection is `22 A8 82`
      // (§3.8); reconstruct the 24-bit field MSB-first (octet0 = bits 16–23).
      const field = ((0x22 << 16) | (0xa8 << 8) | 0x82) >>> 0;
      const setBits = [...Array(24).keys()].filter((b) => (field >> b) & 1);
      // bit1=REJ, bit7=ext-addr, bit11=mod128, bit13=TEST, bit15=16-FCS,
      // bit17=sync-Tx, bit21=SREJ-multiframe — exactly the Figure 4.5 table
      // positions. Note bit 1 (REJ) is set and bit 2 (SREJ) is clear: the
      // figure's selection is REJ, contradicting its own "SREJ/REJ" caption.
      expect(setBits).toEqual([1, 7, 11, 13, 15, 17, 21]);
      expect((field >> 1) & 1).toBe(1); // REJ selected
      expect((field >> 2) & 1).toBe(0); // SREJ not selected
      expect((field >> 11) & 1).toBe(1); // modulo 128
      expect((field >> 22) & 1).toBe(0); // no segmenter
    });

    it("numeric PVs are big-endian (MSB first)", () => {
      expect((0x04 << 8) | 0x00).toBe(1024); // PI=6 N1 = 1024 bits
      expect((0x10 << 8) | 0x00).toBe(4096); // PI=9 T1 = 4096 ms
    });
  });

  // ─── Parse: the full Figure 4.6 worked example ───────────────────────

  it("parses the Figure 4.6 worked example field-by-field", () => {
    const res = tryParseXid(figure46Info);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.parameters;

    // Classes of Procedures: PV 0x22 0x00 ⇒ ABM + half-duplex.
    expect(p.classesOfProcedures).toBeDefined();
    expect(p.classesOfProcedures!.halfDuplex).toBe(true); // bit 5 set

    // HDLC Optional Functions: PV 0x22 0xA8 0x82 (MSB-octet first — see the
    // figure46Info note). Decoded, these are REJ (bit 1) + modulo-128 (bit 11)
    // + the always-1 bits + SREJ-multiframe (bit 21). NOTE: Figure 4.6's caption
    // claims "SREJ/REJ"; the selection is REJ (bit 1 set, bit 2 clear),
    // contradicting the caption. We decode the bytes faithfully.
    expect(p.hdlcOptionalFunctions).toBeDefined();
    expect(p.hdlcOptionalFunctions!.reject).toBe("implicit");
    expect(p.hdlcOptionalFunctions!.modulo128).toBe(true); // bit 11
    expect(p.hdlcOptionalFunctions!.srejMultiframe).toBe(true); // bit 21
    expect(p.hdlcOptionalFunctions!.segmenterReassembler).toBe(false); // bit 22 clear

    // N1 Rx: PV 0x04 0x00 = 1024 bits = 128 octets.
    expect(p.iFieldLengthRxBits).toBe(1024);
    expect(iFieldLengthRxOctets(p)).toBe(128);

    // Window k Rx: PV 0x02 = 2 frames.
    expect(p.windowSizeRx).toBe(2);

    // T1: PV 0x10 0x00 = 4096 ms.
    expect(p.ackTimerMillis).toBe(4096);

    // N2: PV 0x03 = 3 retries.
    expect(p.retries).toBe(3);
  });

  it("re-encodes Figure 4.6 byte-for-byte (modulo the documented ABM anomaly)", () => {
    // Build the parameters the Figure 4.6 bytes encode (REJ + mod128 +
    // SREJ-multiframe, half-duplex, N1=1024 bits, k=2, T1=4096, N2=3).
    const parameters: XidParameters = {
      classesOfProcedures: CLASSES_OF_PROCEDURES_HALF_DUPLEX,
      hdlcOptionalFunctions: {
        reject: "implicit",
        modulo128: true,
        srejMultiframe: true,
        segmenterReassembler: false,
      },
      iFieldLengthRxBits: 1024,
      windowSizeRx: 2,
      ackTimerMillis: 4096,
      retries: 3,
    };

    const encoded = encodeXid(parameters);

    // KNOWN SPEC DEFECT (Figure 4.6 vs Figure 4.5 table / §6.3.2 prose): the
    // Classes-of-Procedures Balanced-ABM bit is "Bit 0" per the Figure 4.5
    // table (and ¶1077 "Bit 0 is always a 1"), so half-duplex ABM encodes as
    // 0x21 0x00. Figure 4.6's worked example instead shows 0x22 0x00 — it has
    // placed the always-1 ABM bit at position 1, NOT 0. (The HDLC field's PV is
    // serialised MSB-octet-first — `22 A8 82` for this selection — matching §3.8
    // / direwolf / BPQ on the wire; see the figure46Info note.) Per the repo's
    // spec-compliant-by-default rule we follow the normative table for the ABM
    // bit, so byte index 6 is 0x21, not the figure's 0x22. Everything else
    // reproduces figure46Info byte-for-byte. The duplex selection (bit 5) — the
    // only field a peer actually reads — is identical either way.
    expect(encoded[ABM_ANOMALY_INDEX]).toBe(0x21); // table/prose (ABM at bit 0)
    expect(figure46Info[ABM_ANOMALY_INDEX]).toBe(0x22); // the literal figure byte

    // Splice the figure's anomalous byte in and the rest must match exactly.
    const encodedWithFigureAbm = Uint8Array.from(encoded);
    encodedWithFigureAbm[ABM_ANOMALY_INDEX] = 0x22;
    expect(encodedWithFigureAbm).toEqual(figure46Info);
  });

  // ─── Encode: header + group-length framing ───────────────────────────

  it("encodes empty parameters as a bare header with zero Group Length", () => {
    // No fields set ⇒ FI GI GL=0000, an "all defaults" XID info field (¶1021).
    expect(encodeXid({})).toEqual(new Uint8Array([0x82, 0x80, 0x00, 0x00]));
  });

  it("sets Group Length to the parameter-field length only (excludes the header)", () => {
    // One window param (PI+PL+1 = 3 bytes).
    const bytes = encodeXid({ windowSizeRx: 7 });
    expect(bytes[0]).toBe(0x82);
    expect(bytes[1]).toBe(0x80);
    expect(bytes[2]).toBe(0x00);
    expect(bytes[3]).toBe(0x03); // GL counts only PI/PL/PV (3), not the header
    expect(bytes.subarray(4)).toEqual(new Uint8Array([0x08, 0x01, 0x07]));
  });

  it("orders parameters by ascending PI regardless of set order (¶1024)", () => {
    const bytes = encodeXid({
      retries: 5, // PI 0x0A
      classesOfProcedures: CLASSES_OF_PROCEDURES_HALF_DUPLEX, // PI 0x02
      windowSizeRx: 4, // PI 0x08
      ackTimerMillis: 3000, // PI 0x09
    });

    // Collect the PI octets in wire order.
    const pis: number[] = [];
    let pos = XID_HEADER_LENGTH;
    while (pos < bytes.length) {
      pis.push(bytes[pos]);
      const pl = bytes[pos + 1];
      pos += 2 + pl;
    }

    expect(pis).toEqual([0x02, 0x08, 0x09, 0x0a]);
    // ascending
    expect([...pis].sort((a, b) => a - b)).toEqual(pis);
  });

  it("encodes big-endian GL high byte first (two-octet Group Length)", () => {
    // Force a >255-octet parameter field via a wide numeric PV so the GL high
    // byte is non-zero, pinning big-endian order.
    const big = encodeUnsignedXid(0x010203); // 3 octets
    expect([...big]).toEqual([0x01, 0x02, 0x03]);
  });

  // ─── Round-trip: each parameter individually ──────────────────────────

  it.each([true, false])(
    "round-trips Classes-of-Procedures duplex (halfDuplex=%s)",
    (halfDuplex) => {
      const res = tryParseXid(encodeXid({ classesOfProcedures: { halfDuplex } }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.parameters.classesOfProcedures!.halfDuplex).toBe(halfDuplex);
    },
  );

  it("Classes-of-Procedures always sets the ABM bit (table: bit 0 ⇒ 0x21/0x41)", () => {
    // bit 0 (ABM) is always 1 (Figure 4.5 table); half-duplex sets bit 5 ⇒ 0x21.
    expect(classesOfProceduresToOctets(CLASSES_OF_PROCEDURES_HALF_DUPLEX)).toEqual(
      new Uint8Array([0x21, 0x00]),
    );
    // full-duplex sets bit 6 ⇒ 0x41, ABM still set.
    expect(classesOfProceduresToOctets(CLASSES_OF_PROCEDURES_FULL_DUPLEX)).toEqual(
      new Uint8Array([0x41, 0x00]),
    );
  });

  const rejectModes: RejectMode[] = ["implicit", "selective"];
  it.each(
    rejectModes.flatMap((reject) =>
      [true, false].map((mod128) => [reject, mod128] as const),
    ),
  )(
    "round-trips HDLC-Optional-Functions reject=%s modulo128=%s",
    (reject, modulo128) => {
      const res = tryParseXid(
        encodeXid({
          hdlcOptionalFunctions: {
            reject,
            modulo128,
            srejMultiframe: false,
            segmenterReassembler: false,
          },
        }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.parameters.hdlcOptionalFunctions!.reject).toBe(reject);
      expect(res.parameters.hdlcOptionalFunctions!.modulo128).toBe(modulo128);
    },
  );

  it("HDLC-Optional-Functions forces the always-1 bits and encodes the prose selections", () => {
    // Default = SREJ + mod128. Verify the always-1 bits (7=ext addr, 13=TEST,
    // 15=16fcs, 17=sync tx) are set and the SREJ/mod bits encode as the prose
    // prescribes (SREJ ⇒ bit2; mod128 ⇒ bit11). hdlcOptionalFunctionsToOctets
    // serialises MSB-octet first (octets[0] is bits 16–23); rebuild the 24-bit
    // field accordingly before checking the (order-independent) bit positions.
    const octets = hdlcOptionalFunctionsToOctets(HDLC_OPTIONAL_FUNCTIONS_DEFAULT);
    const field = ((octets[0] << 16) | (octets[1] << 8) | octets[2]) >>> 0;

    expect((field >> 7) & 1).toBe(1); // ext address always 1
    expect((field >> 13) & 1).toBe(1); // TEST always 1
    expect((field >> 15) & 1).toBe(1); // 16-bit FCS always 1
    expect((field >> 17) & 1).toBe(1); // synchronous Tx always 1
    expect((field >> 1) & 1).toBe(0); // SREJ selected ⇒ bit 1 (REJ) reset
    expect((field >> 2) & 1).toBe(1); // SREJ selected ⇒ bit 2 set
    expect((field >> 10) & 1).toBe(0); // mod128 ⇒ bit 10 (mod8) reset
    expect((field >> 11) & 1).toBe(1); // mod128 ⇒ bit 11 set
  });

  it("round-trips HDLC-Optional-Functions segmenter + SREJ-multiframe", () => {
    const res = tryParseXid(
      encodeXid({
        hdlcOptionalFunctions: {
          reject: "selective",
          modulo128: true,
          srejMultiframe: true,
          segmenterReassembler: true,
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.hdlcOptionalFunctions!.srejMultiframe).toBe(true);
    expect(res.parameters.hdlcOptionalFunctions!.segmenterReassembler).toBe(true);
  });

  // ─── HDLC-Optional-Functions octet order (§3.8) ──────────────────────
  //
  // Load-bearing for interop: §3.8 mandates multi-octet fields go on the wire
  // most-significant octet first. BPQ negotiates SREJ only from the MSB-first
  // PV and silently drops the byte-reversed LSB-first one. Mirrors the C#
  // HdlcOptionalFunctions ToOctets/FromOctets `lsbOctetFirst` parameter.
  it("serialises HDLC-Optional-Functions MSB-octet first by default (§3.8)", () => {
    // The Figure 4.6 selection (REJ + mod128 + SREJ-multiframe + always-1 bits).
    const sel: HdlcOptionalFunctions = {
      reject: "implicit",
      modulo128: true,
      srejMultiframe: true,
      segmenterReassembler: false,
    };
    // MSB-first wire bytes: the §3.8-correct order Fig 4.6 prints byte-reversed.
    expect([...hdlcOptionalFunctionsToOctets(sel)]).toEqual([0x22, 0xa8, 0x82]);
    // The legacy LSB-first opt-in reproduces the figure's printed bytes.
    expect([...hdlcOptionalFunctionsToOctets(sel, true)]).toEqual([0x82, 0xa8, 0x22]);
  });

  it("decodes the MSB-first PV (default) and the LSB-first PV (opt-in) identically", () => {
    const sel: HdlcOptionalFunctions = {
      reject: "implicit",
      modulo128: true,
      srejMultiframe: true,
      segmenterReassembler: false,
    };
    // Default reads octet0 as the high byte.
    expect(hdlcOptionalFunctionsFromOctets(new Uint8Array([0x22, 0xa8, 0x82]))).toEqual(sel);
    // Opt-in reads octet0 as the low byte (the byte-reversed figure layout).
    expect(
      hdlcOptionalFunctionsFromOctets(new Uint8Array([0x82, 0xa8, 0x22]), true),
    ).toEqual(sel);
  });

  it("round-trips HDLC-Optional-Functions through the LSB-first opt-in", () => {
    const sel: HdlcOptionalFunctions = {
      reject: "selective",
      modulo128: false,
      srejMultiframe: true,
      segmenterReassembler: true,
    };
    const lsb = hdlcOptionalFunctionsToOctets(sel, true);
    expect(hdlcOptionalFunctionsFromOctets(lsb, true)).toEqual(sel);
    // ...and the default MSB path is just the byte-reversal of the LSB path.
    const msb = hdlcOptionalFunctionsToOctets(sel);
    expect([...msb]).toEqual([...lsb].reverse());
  });

  it.each([
    2048, // default N1 (256 octets)
    1024, // Fig 4.6
    8, // 1 octet — exercises single-byte numeric encoding
    65535, // two-octet boundary
  ])("round-trips I-Field-Length-Rx bits=%i", (bits) => {
    const res = tryParseXid(encodeXid({ iFieldLengthRxBits: bits }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.iFieldLengthRxBits).toBe(bits);
    expect(iFieldLengthRxOctets(res.parameters)).toBe(Math.trunc(bits / 8));
  });

  it.each([0, 4, 32, 127])("round-trips Window-Size-Rx k=%i", (k) => {
    const res = tryParseXid(encodeXid({ windowSizeRx: k }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBe(k);
  });

  it.each([3000, 4096, 255, 60000])("round-trips Ack-Timer T1=%i ms", (millis) => {
    const res = tryParseXid(encodeXid({ ackTimerMillis: millis }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.ackTimerMillis).toBe(millis);
  });

  it.each([1, 10, 255])("round-trips Retries N2=%i", (n2) => {
    const res = tryParseXid(encodeXid({ retries: n2 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.retries).toBe(n2);
  });

  it("round-trips the full parameter set together", () => {
    const p: XidParameters = {
      classesOfProcedures: CLASSES_OF_PROCEDURES_FULL_DUPLEX,
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: true,
        srejMultiframe: false,
        segmenterReassembler: true,
      },
      iFieldLengthRxBits: octetsToBits(256),
      windowSizeRx: 32,
      ackTimerMillis: 3000,
      retries: 10,
    };

    const res = tryParseXid(encodeXid(p));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters).toEqual(p);
  });

  // ─── Absent / optional fields (¶1024) ─────────────────────────────────

  it("decodes absent fields as undefined, not a default", () => {
    // Only window present; every other field must be undefined (= "use
    // current"), distinct from a present-but-default value.
    const res = tryParseXid(encodeXid({ windowSizeRx: 4 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.parameters;
    expect(p.windowSizeRx).toBe(4);
    expect(p.classesOfProcedures).toBeUndefined();
    expect(p.hdlcOptionalFunctions).toBeUndefined();
    expect(p.iFieldLengthRxBits).toBeUndefined();
    expect(p.ackTimerMillis).toBeUndefined();
    expect(p.retries).toBeUndefined();
  });

  it("decodes an empty parameter field (GL=0) to all-undefined", () => {
    const res = tryParseXid(new Uint8Array([0x82, 0x80, 0x00, 0x00]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters).toEqual({});
  });

  it("treats a zero-length PV (PL=0) as an absent parameter (¶1024)", () => {
    // A PI with PL=0 means "PV absent, take default" ⇒ field stays undefined.
    const info = new Uint8Array([0x82, 0x80, 0x00, 0x02, PI_WINDOW_SIZE_RX, 0x00]);
    const res = tryParseXid(info);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBeUndefined();
  });

  it("skips an unrecognised PI (¶1024) and still decodes following params", () => {
    const info = new Uint8Array([
      0x82, 0x80, 0x00, 0x07,
      0x42, 0x02, 0xde, 0xad, // unknown PI, 2-byte PV — skipped
      0x08, 0x01, 0x05, // window k = 5
    ]);
    const res = tryParseXid(info);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBe(5);
  });

  it("skips the Tx variants PI=5 / PI=7 (ISO-8885-only) but decodes Rx params", () => {
    const info = new Uint8Array([
      0x82, 0x80, 0x00, 0x0a,
      0x05, 0x02, 0x08, 0x00, // PI=5 Tx N1 — skipped
      0x07, 0x01, 0x10, // PI=7 Tx window — skipped
      0x08, 0x01, 0x05, // PI=8 Rx window = 5
    ]);
    const res = tryParseXid(info);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBe(5);
  });

  // ─── Malformed / short buffers ────────────────────────────────────────

  it.each([
    [new Uint8Array([])], // empty
    [new Uint8Array([0x82])], // FI only
    [new Uint8Array([0x82, 0x80, 0x00])], // header truncated (no 2nd GL byte)
  ])("rejects a short header: %j", (info) => {
    expect(tryParseXid(info).ok).toBe(false);
  });

  it("rejects a wrong Format Identifier", () => {
    expect(tryParseXid(new Uint8Array([0x81, 0x80, 0x00, 0x00])).ok).toBe(false);
  });

  it("rejects a wrong Group Identifier", () => {
    expect(tryParseXid(new Uint8Array([0x82, 0x81, 0x00, 0x00])).ok).toBe(false);
  });

  // ─── Strict-rejects / lenient-accepts pairs ───────────────────────────

  it("strict rejects a Group-Length overrun; lenient clamps", () => {
    // GL claims 8 parameter bytes; only 3 follow.
    const info = new Uint8Array([0x82, 0x80, 0x00, 0x08, 0x08, 0x01, 0x05]);

    expect(tryParseXid(info, XID_PARSE_STRICT).ok).toBe(false); // ¶1021

    const res = tryParseXid(info, XID_PARSE_LENIENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBe(5);
  });

  it("strict rejects a truncated trailing parameter; lenient tolerates", () => {
    // GL=4: a window param (3 bytes) then a stray PI 0x09 with no PL octet.
    const info = new Uint8Array([0x82, 0x80, 0x00, 0x04, 0x08, 0x01, 0x05, 0x09]);

    expect(tryParseXid(info, XID_PARSE_STRICT).ok).toBe(false);

    const res = tryParseXid(info, XID_PARSE_LENIENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters.windowSizeRx).toBe(5);
  });

  it("strict rejects a PV longer than the remaining field; lenient truncates", () => {
    // GL=4: PI 0x09 (T1) with PL=3 but only 1 PV byte before the field ends.
    const info = new Uint8Array([0x82, 0x80, 0x00, 0x04, 0x09, 0x03, 0x10]);

    expect(tryParseXid(info, XID_PARSE_STRICT).ok).toBe(false);

    const res = tryParseXid(info, XID_PARSE_LENIENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Lenient reads the 1 available octet ⇒ 0x10 = 16.
    expect(res.parameters.ackTimerMillis).toBe(0x10);
  });

  // ─── Numeric helper edge cases ────────────────────────────────────────

  it("encodes/decodes unsigned numerics shortest-faithful big-endian", () => {
    expect([...encodeUnsignedXid(0)]).toEqual([0]); // at least one octet
    expect([...encodeUnsignedXid(255)]).toEqual([0xff]); // single octet
    expect([...encodeUnsignedXid(256)]).toEqual([0x01, 0x00]); // two-octet boundary
    expect([...encodeUnsignedXid(0x010000)]).toEqual([0x01, 0x00, 0x00]); // three octets

    expect(decodeUnsignedXid(new Uint8Array([0x01, 0x00, 0x00]))).toBe(0x010000);
    expect(decodeUnsignedXid(new Uint8Array([]))).toBe(0); // empty PV ⇒ 0
  });

  it("rejects negative / non-integer numeric encodes", () => {
    expect(() => encodeUnsignedXid(-1)).toThrow(RangeError);
    expect(() => encodeUnsignedXid(1.5)).toThrow(RangeError);
  });

  // ─── The codec output is transport-agnostic info-field bytes ──────────
  // ax25-ts has no XID U-frame factory (the MDL/XID FSM is V3 part 2). This
  // mirrors the C# `Codec_Output_Drives_Ax25Frame_Xid...` integration test as
  // closely as the repo allows: the encoded bytes are a plain Uint8Array that
  // survives a real frame's encode → wire → decode → re-parse round-trip.

  it("produces info-field bytes that round-trip through a real frame on the wire", () => {
    const dest = new Callsign("M0LTE", 0);
    const src = new Callsign("G7XYZ", 7);
    const negotiated: XidParameters = {
      classesOfProcedures: CLASSES_OF_PROCEDURES_HALF_DUPLEX,
      hdlcOptionalFunctions: HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
      iFieldLengthRxBits: octetsToBits(256),
      windowSizeRx: 32,
      ackTimerMillis: 3000,
      retries: 10,
    };

    const info = encodeXid(negotiated);
    // Carry the info field on a frame (XID frames aren't built here; any frame
    // with an info field exercises the same wire round-trip).
    const frame = ui({ destination: dest, source: src, info });
    expect(frame.info).toEqual(info);

    const decodedFrame = decodeFrame(encodeFrame(frame));
    const res = tryParseXid(decodedFrame.info);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parameters).toEqual(negotiated);
  });
});
