import {
  type ClassesOfProcedures,
  CLASSES_OF_PROCEDURES_HALF_DUPLEX,
  type HdlcOptionalFunctions,
  HDLC_OPTIONAL_FUNCTIONS_DEFAULT,
  iFieldLengthRxOctets,
  type XidParameters,
} from "../xid.js";
import type { Ax25SessionContext } from "./session-context.js";

/**
 * The substantive XID parameter-negotiation logic of the management data-link
 * (MDL, figc5.2): the §6.3.2 "reverts-to" merge that turns our offered
 * parameters and the peer's XID response into the agreed link parameters, and
 * the §6.3.2 ¶1 / §1436 version-2.0 default set used when a pre-v2.2 peer
 * rejects the XID command with a FRMR.
 *
 * Pulled out of the MDL driver into pure static merge functions so the
 * per-parameter rules are unit-testable in isolation and carry their spec
 * citations inline. The MDL figc5.2 "Apply Negotiated Parameters" box is a
 * single placeholder verb in the prose-bootstrap SDL (the figc5.3–figc5.8
 * per-parameter subroutines were not transcribed); this is its runtime body.
 *
 * "offered" = the parameters we put in our XID *command* (our Rx capability /
 * preference). "response" = the parameters the peer returned in its XID
 * *response*. Per §6.3.2 ¶7 "Both TNCs set up based on the values used in the
 * XID response" — but the spec's per-parameter rules (lesser / greater / min)
 * are deterministic functions of the two offers, so we re-derive the agreed
 * value here rather than trusting the peer to have applied the rule correctly.
 * That keeps both stations convergent even if a peer echoes its own offer
 * verbatim.
 *
 * The TypeScript parity leg of packet.net's `Packet.Ax25.Session.XidNegotiator`
 * (m0lte/packet.net#271, v2.2 arc V3 part 2).
 */

/**
 * Apply the §6.3.2 reverts-to merge of `offered` (what we sent in our XID
 * command) and `response` (what the peer returned in its XID response) to
 * `context`, replacing the forced establishment defaults with the negotiated
 * values. Each parameter absent from *both* offers retains the context's
 * current value (§4.3.3.7 ¶1024 / §6.3.2 "if this field is not present, the
 * current values are retained").
 */
export function applyNegotiated(
  context: Ax25SessionContext,
  offered: XidParameters,
  response: XidParameters,
): void {
  // ─── HDLC Optional Functions (PI=3): reject scheme + modulo ──────────
  //
  // §6.3.2 ¶1426: "Function reverts to the lesser of the selection offered in
  // the XID command and XID response frames. Ordering is (highest to lowest):
  // selective reject and implicit reject; Modulo 128 and modulo 8." So the
  // agreed value is the LOWER of the two on each axis:
  //   reject:  SREJ (higher) vs REJ (lower)  → REJ wins if either side offers REJ
  //   modulo:  128 (higher)  vs 8   (lower)  → mod-8 wins if either side offers mod-8
  // If PI=3 is absent from both, §6.3.2 ¶1426 selects the default (selective
  // reject, modulo 128) — represented by HDLC_OPTIONAL_FUNCTIONS_DEFAULT.
  const ourHdlc: HdlcOptionalFunctions =
    offered.hdlcOptionalFunctions ?? HDLC_OPTIONAL_FUNCTIONS_DEFAULT;
  const theirHdlc: HdlcOptionalFunctions =
    response.hdlcOptionalFunctions ?? HDLC_OPTIONAL_FUNCTIONS_DEFAULT;

  // "lesser of the selection": SREJ only survives if BOTH sides offer it.
  const agreedSelectiveReject =
    ourHdlc.reject === "selective" && theirHdlc.reject === "selective";

  // "lesser of the selection": mod-128 only survives if BOTH sides offer it.
  const agreedModulo128 = ourHdlc.modulo128 && theirHdlc.modulo128;

  // Segmenter/reassembler (the §1419 v2.2 capability) is a mutual-capability
  // bit — enabled only if both sides advertise it. Not part of the explicit
  // reverts-to prose, but the §6.3.2 ¶1419 "enables the use of the
  // segmenter/reassembler" framing is a mutual-capability AND.
  const agreedSegmenter =
    ourHdlc.segmenterReassembler && theirHdlc.segmenterReassembler;

  context.srejEnabled = agreedSelectiveReject;
  context.implicitReject = !agreedSelectiveReject;
  context.isExtended = agreedModulo128;
  context.segmenterReassemblerEnabled = agreedSegmenter;

  // ─── Classes of Procedures (PI=2): duplex ────────────────────────────
  //
  // §6.3.2 ¶1424: "reverts to half-duplex if either TNC cannot support
  // full-duplex." Full-duplex survives only if BOTH sides offer it; absent
  // from both → default half-duplex.
  const ourCop: ClassesOfProcedures =
    offered.classesOfProcedures ?? CLASSES_OF_PROCEDURES_HALF_DUPLEX;
  const theirCop: ClassesOfProcedures =
    response.classesOfProcedures ?? CLASSES_OF_PROCEDURES_HALF_DUPLEX;
  const agreedFullDuplex = !ourCop.halfDuplex && !theirCop.halfDuplex;
  context.halfDuplex = !agreedFullDuplex;

  // ─── Window Size Receive k (PI=8): notification / min ────────────────
  //
  // §6.3.2 ¶1430 / §4.3.3.7: k is a NOTIFICATION of the receiver's buffering
  // capacity ("the maximum size of the window it will handle without error. A
  // transmitting TNC may not exceed this size"). So OUR send window is bounded
  // by the PEER's advertised Rx capacity; take the min of the two so neither
  // side overruns the other's buffer. If neither side advertised k, leave the
  // context's current value (which establishment seeded to 4/32 by modulo).
  const agreedK = minPresent(offered.windowSizeRx, response.windowSizeRx);
  if (agreedK !== undefined) context.k = agreedK;

  // ─── I-Field Length Receive N1 (PI=6): notification / min ────────────
  //
  // §6.3.2 ¶1428 / §4.3.3.7: N1 is likewise a notification ("the maximum size
  // of an Information field it will handle without error. A transmitting TNC
  // may not exceed this size"). Our outbound frames must not exceed the peer's
  // advertised Rx N1; take the min. Stored in octets on the context (the codec
  // exposes the bits→octets bridge).
  const agreedN1 = minPresent(
    iFieldLengthRxOctets(offered),
    iFieldLengthRxOctets(response),
  );
  if (agreedN1 !== undefined) context.n1 = agreedN1;

  // ─── Acknowledge Timer T1 (PI=9): greater ────────────────────────────
  //
  // §6.3.2 ¶1432: "Function reverts to the greater of the values offered in
  // the XID command and XID response frames." A longer T1 is the safe (more
  // patient) choice on a slow/lossy link, so both sides adopt the max. T1V is
  // the operating timeout; we also re-seed SRT so T1V := 2*SRT recomputations
  // stay consistent with the negotiated value.
  const agreedT1 = maxPresent(offered.ackTimerMillis, response.ackTimerMillis);
  if (agreedT1 !== undefined) {
    context.t1vMs = agreedT1;
    context.srtMs = agreedT1 / 2;
  }

  // ─── Retries N2 (PI=10): greater ─────────────────────────────────────
  //
  // §6.3.2 ¶1434: "reverts to the greater of the values offered." (The prose
  // labels it "N1" but the §4.3.3.7 PI=10 table and Fig 4.6 make clear this is
  // the retry count N2.) More retries is the safer choice, so both sides adopt
  // the max.
  const agreedN2 = maxPresent(offered.retries, response.retries);
  if (agreedN2 !== undefined) context.n2 = agreedN2;
}

/**
 * Install the complete AX.25 version-2.0 default parameter set per §6.3.2 ¶1 /
 * §1436 — used when a pre-v2.2 peer FRMRs our XID command (figc5.2 FRMR path)
 * and "a version 2.0 connection is made". This is the FULL set, not merely
 * `isExtended = false`:
 *   - Set Half Duplex
 *   - Set Implicit Reject (SREJ off)
 *   - Modulo = 8 (mod-8, not extended)
 *   - I Field Length Receive N1 = 2048 bits = 256 octets
 *   - Window Size Receive k = 7
 *   - Acknowledge Timer T1 = 3000 ms
 *   - Retries N2 = 10
 *
 * The data-link `set_version_2_0` verb only clears `isExtended` (the data-link
 * figc4.6 fallback runs its remaining v2.0 verbs separately). The MDL figc5.2
 * FRMR transition draws a single `Set Version 2.0` box, so the MDL owes the
 * complete set here. §1436's k=7 is the version-2.0 default; note it is NOT the
 * mod-8 XID offer default (k=4) — the v2.0 fallback explicitly uses 7. The
 * segmenter/reassembler is a v2.2-only capability (§1419) so it is disabled on
 * the v2.0 fallback. Mirrors the C# `XidNegotiator.ApplyVersion20Defaults`.
 */
export function applyVersion20Defaults(context: Ax25SessionContext): void {
  context.halfDuplex = true; // Set Half Duplex
  context.implicitReject = true; // Set Implicit Reject
  context.srejEnabled = false; //   (REJ ⇒ no SREJ)
  context.isExtended = false; // Modulo = 8
  context.n1 = 256; // 2048 bits = 256 octets
  context.k = 7; // Window Size Receive = 7
  context.t1vMs = 3000; // Acknowledge Timer
  context.srtMs = 1500; //   keep T1V == 2*SRT
  context.n2 = 10; // Retries
  context.segmenterReassemblerEnabled = false; // v2.2-only (§1419)
}

/** Lesser of two notification values, treating `undefined` as "no constraint". */
function minPresent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Greater of two negotiated values, treating `undefined` as "no preference". */
function maxPresent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
