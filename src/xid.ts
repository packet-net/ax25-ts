/**
 * Codec for the AX.25 v2.2 XID (Exchange Identification) *information field* —
 * the TLV parameter-negotiation payload carried inside an XID U-frame
 * (§4.3.3.7 "Exchange Identification (XID) Frame", parameter table Figure 4.5,
 * worked example Figure 4.6). This is the wire format the MDL (Management
 * Data-Link, App. C5) exchange negotiates over; the codec is transport-agnostic
 * — the resulting bytes go into the `info` field of an XID frame, and bytes
 * pulled off a received XID frame's `info` come back here.
 *
 * Layout (§4.3.3.7 ¶1017–1024):
 *
 * ```
 *   FI (1)  Format Identifier  = 0x82 (general-purpose XID information)
 *   GI (1)  Group Identifier   = 0x80 (parameter-negotiation identifier)
 *   GL (2)  Group Length       = length of the parameter field that follows,
 *                                big-endian, NOT counting FI/GI/GL themselves
 *   parameter field: a run of PI/PL/PV triples in ascending PI order
 *     PI (1)  Parameter Identifier
 *     PL (1)  Parameter Length  = length of PV in octets (excludes PI and PL)
 *     PV (PL) Parameter Value
 * ```
 *
 * A `PL` of zero means the PV is absent and the parameter takes its default; an
 * omitted PI/PL/PV triple means "use the currently-negotiated value"; an
 * unrecognised PI is ignored (§4.3.3.7 ¶1024). We model "absent" as
 * `undefined` on {@link XidParameters}, distinct from a present-but-default
 * value.
 *
 * **Strict by construction.** {@link encodeXid} emits exactly the fields set on
 * {@link XidParameters}, in ascending-PI order, with the fixed/reserved bits of
 * the bit-fields (Classes of Procedures, HDLC Optional Functions) forced to
 * their spec-mandated constants. It never produces a malformed field. Parser
 * leniency for real-world peers lives behind named flags on
 * {@link XidParseOptions}; the default is spec-strict.
 *
 * The TS parity leg of packet.net's `Packet.Ax25.Xid.XidInfoField`
 * (m0lte/packet.net#270, v2.2 arc V3 part 1). This is the codec only — the
 * MDL/XID negotiation FSM (figc5.1–5.8, not transcribed in m0lte/ax25sdl) is a
 * follow-up (V3 part 2).
 */

/** Format Identifier for general-purpose XID information (§4.3.3.7 ¶1019). */
export const XID_FORMAT_IDENTIFIER = 0x82;

/** Group Identifier for the parameter-negotiation group (§4.3.3.7 ¶1020). */
export const XID_GROUP_IDENTIFIER = 0x80;

/** Minimum encoded length: FI + GI + GL with an empty parameter field. */
export const XID_HEADER_LENGTH = 4;

// ─── Parameter identifiers (Figure 4.5 "PI" column) ──────────────────────

/** PI=2 — Classes of Procedures (half/full duplex, ABM). Figure 4.5. */
export const PI_CLASSES_OF_PROCEDURES = 0x02;

/** PI=3 — HDLC Optional Functions (REJ/SREJ, modulo, segmenter, …). Figure 4.5. */
export const PI_HDLC_OPTIONAL_FUNCTIONS = 0x03;

/** PI=5 — I Field Length Transmit (bits). ISO 8885; not negotiated by AX.25. */
export const PI_I_FIELD_LENGTH_TX = 0x05;

/** PI=6 — I Field Length Receive, in **bits** (N1×8). Figure 4.5. */
export const PI_I_FIELD_LENGTH_RX = 0x06;

/** PI=7 — Window Size Transmit. ISO 8885; not negotiated by AX.25. */
export const PI_WINDOW_SIZE_TX = 0x07;

/** PI=8 — Window Size Receive (k frames). Figure 4.5. */
export const PI_WINDOW_SIZE_RX = 0x08;

/** PI=9 — Acknowledge Timer T1, in milliseconds. Figure 4.5. */
export const PI_ACK_TIMER = 0x09;

/**
 * PI=10 (0x0A) — Retries (N2). Figure 4.6 labels this "Retries (N2)".
 * (The §4.3.3.7 / §6.3.2 prose miscalls the retry count "N1"; the table name
 * "Retries" and Fig 4.6 are authoritative — this is N2, the link's retry limit,
 * not N1, the I-field length.)
 */
export const PI_RETRIES = 0x0a;

// ─── Classes of Procedures (PI=2) ────────────────────────────────────────

/**
 * The XID "Classes of Procedures" parameter (PI=2, PL=2 — a 16-bit field), per
 * AX.25 v2.2 §4.3.3.7 (Figure 4.5) and the negotiation rules in §6.3.2. For
 * AX.25 only the duplex selection is negotiable; the remaining bits are fixed.
 *
 * Bit layout (LSB-first within each octet; octet 0 transmitted first):
 *   - bit 0 — Balanced ABM: always 1.
 *   - bits 1–4 — Unbalanced NRM/ARM primary/secondary: always 0.
 *   - bit 5 — Half Duplex.
 *   - bit 6 — Full Duplex. Exactly one of bit 5 / bit 6 is set.
 *   - bits 7–15 — Reserved: always 0.
 *
 * Note the spec prose (§6.3.2 ¶1077) says "Bit 0 is always a 1", but Figure 4.6
 * encodes PV 0x22 0x00 = ABM(bit1)+half-duplex(bit5). The discrepancy is the
 * figure's off-by-one in the worked example vs the Figure 4.5 table / §6.3.2
 * prose; we follow the table + prose: ABM is the low bit (0x01) and half-duplex
 * is 0x20, which encodes as 0x21 (not the figure's 0x22). The duplex selection
 * (bit 5) — the only field a peer actually reads — is identical either way.
 */
export interface ClassesOfProcedures {
  /**
   * True for half-duplex, false for full-duplex. The default per §6.3.2 is
   * half-duplex, and the negotiation "reverts to half-duplex if either TNC
   * cannot support full-duplex".
   */
  readonly halfDuplex: boolean;
}

const COP_BIT_ABM_BALANCED = 0; // always 1
const COP_BIT_HALF_DUPLEX = 5;
const COP_BIT_FULL_DUPLEX = 6;

/** Half-duplex Classes of Procedures (the AX.25 default). */
export const CLASSES_OF_PROCEDURES_HALF_DUPLEX: ClassesOfProcedures = {
  halfDuplex: true,
};

/** Full-duplex Classes of Procedures. */
export const CLASSES_OF_PROCEDURES_FULL_DUPLEX: ClassesOfProcedures = {
  halfDuplex: false,
};

/**
 * Encode Classes of Procedures to its 2-octet PV (octet 0 first). ABM (bit 0)
 * is forced set; exactly one of half-duplex (bit 5) / full-duplex (bit 6) is
 * set; all other bits are zero per the Figure 4.5 fixed values.
 */
export function classesOfProceduresToOctets(
  cop: ClassesOfProcedures,
): Uint8Array {
  const field =
    (1 << COP_BIT_ABM_BALANCED) |
    (1 << (cop.halfDuplex ? COP_BIT_HALF_DUPLEX : COP_BIT_FULL_DUPLEX));
  // LSB-first per octet: octet0 = bits 0–7, octet1 = bits 8–15.
  return new Uint8Array([field & 0xff, (field >> 8) & 0xff]);
}

/**
 * Decode Classes of Procedures from the (up to) 2-octet PV. Duplex is read from
 * bits 5/6; if neither is set we default to half-duplex (the spec default). All
 * other bits are ignored on receive — only the duplex selection is meaningful
 * to AX.25.
 */
export function classesOfProceduresFromOctets(
  octet0: number,
  octet1: number,
): ClassesOfProcedures {
  const field = octet0 | (octet1 << 8);
  const full = (field & (1 << COP_BIT_FULL_DUPLEX)) !== 0;
  const half = (field & (1 << COP_BIT_HALF_DUPLEX)) !== 0;
  // Half-duplex unless only full-duplex is asserted.
  return { halfDuplex: !(full && !half) };
}

// ─── HDLC Optional Functions (PI=3) ──────────────────────────────────────

/**
 * The reject scheme negotiated by the HDLC Optional Functions field.
 *   - `"implicit"` — implicit reject (REJ): bit 1 set, bit 2 reset (§6.3.2 ¶1086).
 *   - `"selective"` — selective reject (SREJ): bit 1 reset, bit 2 set (§6.3.2 ¶1087).
 */
export type RejectMode = "implicit" | "selective";

/**
 * The XID "HDLC Optional Functions" parameter (PI=3, PL=3 — a 24-bit field),
 * per AX.25 v2.2 §4.3.3.7 (Figure 4.5) and the negotiation rules in §6.3.2
 * ¶1082–1090. For AX.25 this carries the two genuinely-negotiated selections —
 * the reject scheme (REJ vs SREJ) and the modulo (8 vs 128) — plus the
 * segmenter/reassembler bit; every other bit is fixed.
 *
 * Bit layout (bits 0–23; the bit *numbers* below are in the LSB-octet value
 * space — bits 0–7 are the low octet, 8–15 the middle, 16–23 the high — but on
 * the wire the 3 octets are transmitted **most-significant octet first**; see
 * the octet-order note below):
 *   - bit 0 — Reserved: 0.
 *   - bit 1 — REJ command/response (set ⇒ implicit reject selected).
 *   - bit 2 — SREJ command/response (set ⇒ selective reject selected).
 *   - bits 3–6, 8, 9, 12, 14, 16, 18–20 — fixed 0 (ISO-8885 functions AX.25 doesn't use).
 *   - bit 7 — Extended address: always 1.
 *   - bit 10 — Modulo 8 (set ⇒ modulo-8 selected).
 *   - bit 11 — Modulo 128 (set ⇒ modulo-128 selected).
 *   - bit 13 — TEST command/response: always 1.
 *   - bit 15 — 16-bit FCS: always 1.
 *   - bit 17 — Synchronous transmit: always 1.
 *   - bit 21 — SREJ multiframe.
 *   - bit 22 — Segmenter/reassembler.
 *   - bit 23 — Reserved: 0.
 *
 * Exactly one of bit 1 / bit 2 must be set (clearing both is illegal per
 * ¶1088); exactly one of bit 10 / bit 11 must be set.
 * {@link hdlcOptionalFunctionsToOctets} enforces both invariants and forces the
 * always-1 bits (7, 13, 15, 17).
 *
 * **Octet order (load-bearing for interop).** AX.25 v2.2 §3.8 ("Order of Octet
 * and Bit Transmission") mandates multi-octet fields go on the wire
 * **high-order octet first** (big-endian). The 3-octet HDLC Optional Functions
 * PV is therefore serialised / parsed MSB-octet-first by default: the first
 * octet carries bits 16–23 (incl. SREJ-multiframe, segmenter), the last carries
 * bits 0–7 (incl. the always-1 Extended-Address bit). This is the order direwolf
 * (`xid.c` writes `(x>>16),(x>>8),x`) and LinBPQ (`L2Code.c` writes
 * `xidval>>16` first, parses `value = (value<<8) + *p++`) use, and it is what
 * real peers accept — BPQ negotiates SREJ from the MSB-first PV (`22 A4 84`) and
 * silently drops the byte-reversed LSB-first one (`84 A4 22`). The historical
 * least-significant-octet-first layout is kept only as a non-default opt-in
 * (`lsbOctetFirst`) for regression study and is never put on the wire by the
 * production path.
 *
 * **Spec worked-example note.** Figure 4.6 *prints* PV `82 A8 22` for this
 * selection — but that is the LSB-octet-first (byte-reversed) layout and is a
 * figure error (it contradicts §3.8); a faithful MSB-first serialisation of the
 * same logical selection is `22 A8 82`. Decoded against the normative §6.3.2 bit
 * map, the selection is REJ (bit 1) + Modulo 128 (bit 11) + the always-1 bits +
 * SREJ-multiframe (bit 21) — i.e. the figure selects REJ, not SREJ,
 * contradicting its own "SREJ/REJ" caption. We encode/decode MSB-first per
 * §3.8, not the figure's printed bytes; see the codec's round-trip tests.
 *
 * Mirrors C# `Packet.Ax25.Xid.HdlcOptionalFunctions` (`ToOctets`/`FromOctets`,
 * `lsbOctetFirst` defaulting false = MSB-first).
 */
export interface HdlcOptionalFunctions {
  /** The reject scheme — implicit (REJ) or selective (SREJ). */
  readonly reject: RejectMode;
  /** True ⇒ modulo-128 selected; false ⇒ modulo-8. */
  readonly modulo128: boolean;
  /** True ⇒ the SREJ-multiframe option (bit 21) is asserted. */
  readonly srejMultiframe: boolean;
  /** True ⇒ the segmenter/reassembler option (bit 22) is asserted. */
  readonly segmenterReassembler: boolean;
}

const HOF_BIT_REJ = 1;
const HOF_BIT_SREJ = 2;
const HOF_BIT_EXTENDED_ADDRESS = 7; // always 1
const HOF_BIT_MODULO_8 = 10;
const HOF_BIT_MODULO_128 = 11;
const HOF_BIT_TEST = 13; // always 1
const HOF_BIT_FCS_16 = 15; // always 1
const HOF_BIT_SYNC_TX = 17; // always 1
const HOF_BIT_SREJ_MULTIFRAME = 21;
const HOF_BIT_SEGMENTER = 22;

/**
 * The AX.25 v2.2 default per §6.3.2 ¶1090: selective reject, modulo 128, no
 * segmenter (the figure's absent-field default).
 */
export const HDLC_OPTIONAL_FUNCTIONS_DEFAULT: HdlcOptionalFunctions = {
  reject: "selective",
  modulo128: true,
  srejMultiframe: false,
  segmenterReassembler: false,
};

/**
 * Encode HDLC Optional Functions to its 3-octet PV. Forces the always-1 bits
 * (extended address, TEST, 16-bit FCS, synchronous Tx) and sets exactly one
 * reject bit and exactly one modulo bit. Octet order is governed by
 * `lsbOctetFirst`.
 *
 * @param lsbOctetFirst When `false` (the default, spec-correct per §3.8) the
 *   3-octet value is transmitted **most-significant octet first** (big-endian) —
 *   the order direwolf / LinBPQ use and real peers accept. When `true`,
 *   reproduces the repo's historical (incorrect) least-significant-octet-first
 *   layout — kept only for regression study and never put on the wire by the
 *   production connect path. See the octet-order note on
 *   {@link HdlcOptionalFunctions} and the C# `ToOctets(bool lsbOctetFirst)`.
 */
export function hdlcOptionalFunctionsToOctets(
  hof: HdlcOptionalFunctions,
  lsbOctetFirst = false,
): Uint8Array {
  let field =
    (1 << HOF_BIT_EXTENDED_ADDRESS) |
    (1 << HOF_BIT_TEST) |
    (1 << HOF_BIT_FCS_16) |
    (1 << HOF_BIT_SYNC_TX);

  field |= hof.reject === "implicit" ? 1 << HOF_BIT_REJ : 1 << HOF_BIT_SREJ;
  field |= hof.modulo128 ? 1 << HOF_BIT_MODULO_128 : 1 << HOF_BIT_MODULO_8;

  if (hof.srejMultiframe) field |= 1 << HOF_BIT_SREJ_MULTIFRAME;
  if (hof.segmenterReassembler) field |= 1 << HOF_BIT_SEGMENTER;

  // `>>> 0` keeps the 24-bit field unsigned (bit 22/23 would otherwise make
  // `field` negative under JS's 32-bit signed bitwise ops before the shift).
  field >>>= 0;
  return lsbOctetFirst
    ? // legacy (incorrect) least-significant octet first
      new Uint8Array([field & 0xff, (field >>> 8) & 0xff, (field >>> 16) & 0xff])
    : // spec-correct most-significant octet first (§3.8 / direwolf / BPQ)
      new Uint8Array([(field >>> 16) & 0xff, (field >>> 8) & 0xff, field & 0xff]);
}

/**
 * Decode HDLC Optional Functions from the (up to) 3-octet PV. Reads the reject
 * scheme from bits 1/2 and the modulo from bits 10/11; if a selection is
 * ambiguous or absent we fall back to the spec defaults (SREJ, modulo 128). The
 * fixed always-1/always-0 bits are not validated on receive — only the
 * negotiable selections are meaningful.
 *
 * @param lsbOctetFirst The on-the-wire octet order of `pv`; must match the order
 *   the peer used. `false` (default, spec-correct per §3.8) reads the first
 *   octet as the high byte (direwolf / BPQ); `true` reads the legacy
 *   least-significant-octet-first layout. See {@link hdlcOptionalFunctionsToOctets}.
 */
export function hdlcOptionalFunctionsFromOctets(
  pv: Uint8Array,
  lsbOctetFirst = false,
): HdlcOptionalFunctions {
  let field = 0;
  const n = Math.min(pv.length, 3);
  for (let i = 0; i < n; i++) {
    const shift = lsbOctetFirst ? 8 * i : 8 * (n - 1 - i);
    field |= pv[i] << shift;
  }
  field >>>= 0;

  const rej = (field & (1 << HOF_BIT_REJ)) !== 0;
  const srej = (field & (1 << HOF_BIT_SREJ)) !== 0;
  // SREJ takes precedence if both are (illegally) set; default SREJ if neither.
  const reject: RejectMode = srej
    ? "selective"
    : rej
      ? "implicit"
      : "selective";

  const mod128 = (field & (1 << HOF_BIT_MODULO_128)) !== 0;
  const mod8 = (field & (1 << HOF_BIT_MODULO_8)) !== 0;
  // Default modulo 128 if neither (the spec default); mod-8 only if it alone is
  // asserted.
  const isMod128 = !(mod8 && !mod128);

  return {
    reject,
    modulo128: isMod128,
    srejMultiframe: (field & (1 << HOF_BIT_SREJ_MULTIFRAME)) !== 0,
    segmenterReassembler: (field & (1 << HOF_BIT_SEGMENTER)) !== 0,
  };
}

// ─── Parameter set (the decoded, semantic view) ──────────────────────────

/**
 * The decoded, semantic view of an XID information field's parameter set
 * (AX.25 v2.2 §4.3.3.7, Figure 4.5). Each field is `undefined` when the
 * corresponding PI/PL/PV triple is *absent* from the frame — which, per
 * §4.3.3.7 ¶1024, means "use the currently-negotiated value" rather than any
 * particular default. The negotiation FSM (MDL, App. C5) is responsible for
 * turning a command + response pair into the agreed link parameters; this type
 * is just the wire payload, decoded.
 *
 * Unit conventions, chosen to match the wire format and `Ax25SessionContext`:
 *   - {@link iFieldLengthRxBits} is in **bits** (the wire unit: Figure 4.5 says
 *     "N1×8"); {@link iFieldLengthRxOctets} converts to the N1 octet count the
 *     session uses.
 *   - {@link ackTimerMillis} is in milliseconds (the wire unit).
 *   - {@link windowSizeRx} and {@link retries} are plain counts.
 */
export interface XidParameters {
  /** Classes of Procedures (PI=2) — duplex selection. `undefined` if absent. */
  readonly classesOfProcedures?: ClassesOfProcedures;
  /** HDLC Optional Functions (PI=3) — reject scheme + modulo + segmenter. `undefined` if absent. */
  readonly hdlcOptionalFunctions?: HdlcOptionalFunctions;
  /**
   * I Field Length Receive (PI=6), in **bits** (the wire unit, N1×8).
   * `undefined` if absent. Default 2048 bits (256 octets) per §6.3.2 ¶1092.
   */
  readonly iFieldLengthRxBits?: number;
  /** Window Size Receive k (PI=8), in frames. `undefined` if absent. */
  readonly windowSizeRx?: number;
  /** Acknowledge Timer T1 (PI=9), in milliseconds. `undefined` if absent. */
  readonly ackTimerMillis?: number;
  /** Retries N2 (PI=10), the retry count. `undefined` if absent. */
  readonly retries?: number;
}

/**
 * {@link XidParameters.iFieldLengthRxBits} converted to octets (N1), or
 * `undefined` if the field is absent. The wire value is bits; N1 in the session
 * is octets, so we divide by 8.
 */
export function iFieldLengthRxOctets(p: XidParameters): number | undefined {
  return p.iFieldLengthRxBits === undefined
    ? undefined
    : Math.trunc(p.iFieldLengthRxBits / 8);
}

/**
 * Build an N1 (I-field length, octets) wire value from an octet count,
 * converting to the wire's bit unit. Convenience for callers that think in
 * octets (as the session does).
 */
export function octetsToBits(octets: number): number {
  return octets * 8;
}

// ─── Parse options (leniency knobs) ──────────────────────────────────────

/**
 * Leniency knobs for {@link tryParseXid}. Mirrors the repo's
 * spec-compliant-by-default philosophy (see `CLAUDE.md`): the strict default
 * rejects any malformed XID information field; each accommodation for a
 * non-conformant real-world peer is a named flag, defaulted off.
 *
 * The outbound construction path ({@link encodeXid}) has no equivalent — it is
 * unconditionally strict and never emits a malformed field.
 */
export interface XidParseOptions {
  /**
   * Accept a Group Length that claims more parameter-field bytes than the
   * buffer actually contains, by clamping to the available bytes. Strict spec
   * (§4.3.3.7 ¶1021: GL is the exact parameter-field length) rejects this.
   * Default `false`.
   */
  readonly allowGroupLengthOverrun?: boolean;
  /**
   * Accept a PI/PL whose PV runs past the end of the parameter field (a
   * trailing PI with no PL octet, or a PL larger than the remaining bytes), by
   * taking only the bytes that remain. Strict spec rejects this — a well-formed
   * parameter field is an exact run of complete PI/PL/PV triples. Default
   * `false`.
   */
  readonly allowTruncatedParameter?: boolean;
}

/** Spec-strict: reject any malformed XID information field. The default. */
export const XID_PARSE_STRICT: XidParseOptions = {};

/**
 * Lenient: tolerate a short/over-claimed Group Length and a truncated trailing
 * parameter. Use for ingesting frames from peers that mis-size the XID info
 * field; never for outbound construction.
 */
export const XID_PARSE_LENIENT: XidParseOptions = {
  allowGroupLengthOverrun: true,
  allowTruncatedParameter: true,
};

// ─── Encode ──────────────────────────────────────────────────────────────

/**
 * Encode a non-negative integer as the minimum number of big-endian octets
 * (most-significant first), with at least one octet. Type-B numeric fields
 * (Figure 4.5: N1, T1, N2) are variable-length big-endian numbers; we emit the
 * shortest faithful representation, matching the 1- or 2-octet widths in the
 * Fig 4.6 worked example.
 */
export function encodeUnsignedXid(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `XID numeric parameters are non-negative integers; got ${value}`,
    );
  }
  if (value === 0) return new Uint8Array([0]);

  const octets: number[] = [];
  let v = value;
  while (v > 0) {
    octets.unshift(v & 0xff);
    v = Math.floor(v / 256); // >>> 8 would cap at 32 bits; this stays exact.
  }
  return new Uint8Array(octets);
}

/** Decode a big-endian Type-B numeric field of arbitrary octet width. */
export function decodeUnsignedXid(pv: Uint8Array): number {
  let acc = 0;
  for (const b of pv) {
    acc = acc * 256 + b;
    if (acc > Number.MAX_SAFE_INTEGER) acc = Number.MAX_SAFE_INTEGER; // saturate
  }
  return acc;
}

function pushParameter(sink: number[], pi: number, pv: Uint8Array): void {
  if (pv.length > 0xff) {
    throw new RangeError(
      `XID parameter PI=${pi} PV is ${pv.length} octets; PL is a single octet (max 255)`,
    );
  }
  sink.push(pi, pv.length);
  for (const b of pv) sink.push(b);
}

/**
 * Encode a set of negotiation parameters into the XID information-field bytes
 * (FI + GI + GL + ordered PI/PL/PV). Only the defined fields of `parameters`
 * are emitted, in ascending PI order per §4.3.3.7 ¶1024. The result is suitable
 * as the `info` field of an XID U-frame.
 */
export function encodeXid(parameters: XidParameters): Uint8Array {
  // Build the parameter field first so we know the group length.
  const pf: number[] = [];

  if (parameters.classesOfProcedures !== undefined) {
    // PI=2, PL=2, PV = 16-bit field, big-endian (octet0 first). The field is
    // defined LSB-first within each octet (verified against Fig 4.6: PV 0x22
    // 0x00 ⇒ bit1 ABM + bit5 half-duplex in the figure; the table puts ABM at
    // bit0 ⇒ 0x21 — we follow the table).
    pushParameter(
      pf,
      PI_CLASSES_OF_PROCEDURES,
      classesOfProceduresToOctets(parameters.classesOfProcedures),
    );
  }

  if (parameters.hdlcOptionalFunctions !== undefined) {
    // PI=3, PL=3, PV = 24-bit field serialised most-significant octet first
    // (§3.8 / Fig 4.6 logical value / direwolf / LinBPQ; see ToOctets). The
    // historical LSB-first layout was an interop bug — BPQ silently drops it and
    // never negotiates SREJ (proven on the wire, packet.net's SrejXidViaNetsim).
    pushParameter(
      pf,
      PI_HDLC_OPTIONAL_FUNCTIONS,
      hdlcOptionalFunctionsToOctets(parameters.hdlcOptionalFunctions),
    );
  }

  if (parameters.iFieldLengthRxBits !== undefined) {
    pushParameter(
      pf,
      PI_I_FIELD_LENGTH_RX,
      encodeUnsignedXid(parameters.iFieldLengthRxBits),
    );
  }

  if (parameters.windowSizeRx !== undefined) {
    // Window size is a single-octet count 0..127 (Figure 4.5: bits 0–6 =
    // 0..127). One octet is the canonical encoding (Fig 4.6 uses PL=1).
    pushParameter(
      pf,
      PI_WINDOW_SIZE_RX,
      new Uint8Array([parameters.windowSizeRx & 0x7f]),
    );
  }

  if (parameters.ackTimerMillis !== undefined) {
    pushParameter(
      pf,
      PI_ACK_TIMER,
      encodeUnsignedXid(parameters.ackTimerMillis),
    );
  }

  if (parameters.retries !== undefined) {
    pushParameter(pf, PI_RETRIES, encodeUnsignedXid(parameters.retries));
  }

  if (pf.length > 0xffff) {
    throw new RangeError(
      `XID parameter field is ${pf.length} octets; Group Length is a 16-bit value (max 65535)`,
    );
  }

  const result = new Uint8Array(XID_HEADER_LENGTH + pf.length);
  result[0] = XID_FORMAT_IDENTIFIER;
  result[1] = XID_GROUP_IDENTIFIER;
  result[2] = (pf.length >> 8) & 0xff; // GL high byte (big-endian).
  result[3] = pf.length & 0xff; // GL low byte.
  result.set(pf, XID_HEADER_LENGTH);
  return result;
}

// ─── Parse ─────────────────────────────────────────────────────────────────

/**
 * The result of {@link tryParseXid}: either a successful decode (with the
 * parameters) or a failure (with a reason, for diagnostics). A discriminated
 * union so callers `if (result.ok)` and TypeScript narrows `result.parameters`.
 */
export type XidParseResult =
  | { readonly ok: true; readonly parameters: XidParameters }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse an XID information field (the bytes from an XID frame's `info`) into a
 * {@link XidParameters}. Returns `{ ok: false }` (without throwing) on a
 * malformed buffer — a bad FI/GI, a truncated header, a Group Length that
 * overruns the buffer, or (under the strict default) a PI/PL whose PV runs past
 * the parameter field. Unrecognised PIs are skipped per §4.3.3.7 ¶1024.
 *
 * @param info    the XID information field octets.
 * @param options leniency knobs; defaults to {@link XID_PARSE_STRICT}.
 */
export function tryParseXid(
  info: Uint8Array,
  options: XidParseOptions = XID_PARSE_STRICT,
): XidParseResult {
  if (info.length < XID_HEADER_LENGTH) {
    return { ok: false, reason: "buffer shorter than the 4-octet FI/GI/GL header" };
  }
  if (info[0] !== XID_FORMAT_IDENTIFIER) {
    return {
      ok: false,
      reason: `Format Identifier 0x${info[0].toString(16)} != 0x82`,
    };
  }
  if (info[1] !== XID_GROUP_IDENTIFIER) {
    return {
      ok: false,
      reason: `Group Identifier 0x${info[1].toString(16)} != 0x80`,
    };
  }

  let groupLength = (info[2] << 8) | info[3]; // big-endian.
  const available = info.length - XID_HEADER_LENGTH;

  if (groupLength > available) {
    // GL claims more parameter bytes than the buffer holds.
    if (!options.allowGroupLengthOverrun) {
      return {
        ok: false,
        reason: `Group Length ${groupLength} overruns the ${available} available parameter octets`,
      };
    }
    groupLength = available; // lenient: clamp to what we actually have.
  }

  const pf = info.subarray(XID_HEADER_LENGTH, XID_HEADER_LENGTH + groupLength);

  let classesOfProcedures: ClassesOfProcedures | undefined;
  let hdlcOptionalFunctions: HdlcOptionalFunctions | undefined;
  let iFieldLengthRxBits: number | undefined;
  let windowSizeRx: number | undefined;
  let ackTimerMillis: number | undefined;
  let retries: number | undefined;

  let pos = 0;
  while (pos < pf.length) {
    const pi = pf[pos++];
    if (pos >= pf.length) {
      // A trailing PI with no room for a PL octet.
      if (!options.allowTruncatedParameter) {
        return { ok: false, reason: `trailing PI=${pi} with no PL octet` };
      }
      break;
    }

    let pl = pf[pos++];
    if (pos + pl > pf.length) {
      // PV runs past the end of the parameter field.
      if (!options.allowTruncatedParameter) {
        return {
          ok: false,
          reason: `PI=${pi} PL=${pl} runs past the end of the parameter field`,
        };
      }
      pl = pf.length - pos; // lenient: take what remains.
    }

    const pv = pf.subarray(pos, pos + pl);
    pos += pl;

    // PL=0 ⇒ PV absent ⇒ parameter takes its default ⇒ leave the field
    // undefined (¶1024). PI=5/PI=7 (Tx variants) and any unrecognised PI are
    // ignored per ¶1024.
    switch (pi) {
      case PI_CLASSES_OF_PROCEDURES:
        if (pl >= 1) {
          classesOfProcedures = classesOfProceduresFromOctets(
            pv[0],
            pl >= 2 ? pv[1] : 0,
          );
        }
        break;

      case PI_HDLC_OPTIONAL_FUNCTIONS:
        if (pl >= 1) hdlcOptionalFunctions = hdlcOptionalFunctionsFromOctets(pv);
        break;

      case PI_I_FIELD_LENGTH_RX:
        if (pl >= 1) iFieldLengthRxBits = decodeUnsignedXid(pv);
        break;

      case PI_WINDOW_SIZE_RX:
        if (pl >= 1) windowSizeRx = pv[0] & 0x7f;
        break;

      case PI_ACK_TIMER:
        if (pl >= 1) ackTimerMillis = decodeUnsignedXid(pv);
        break;

      case PI_RETRIES:
        if (pl >= 1) retries = decodeUnsignedXid(pv);
        break;

      default:
        break;
    }
  }

  // Absent parameters stay `undefined` (= "use current value", ¶1024). The
  // optional fields simply go unset; `tryParseXid(encodeXid(x))` reproduces
  // `x`, and an absent field is distinguishable from a present default because
  // the key is missing rather than holding the default value.
  const parameters: XidParameters = {
    classesOfProcedures,
    hdlcOptionalFunctions,
    iFieldLengthRxBits,
    windowSizeRx,
    ackTimerMillis,
    retries,
  };

  return { ok: true, parameters };
}
