/**
 * v2.2 arc V3 part 2 — the MDL (XID parameter-negotiation) runtime. The TS
 * parity leg of packet.net's `MdlXidNegotiationConformanceTests`
 * (m0lte/packet.net#271).
 *
 * Drives the management data-link FSM (figc5.1 Ready / figc5.2 Negotiating,
 * prose-bootstrap, verification_pending) through the two-station harness. The
 * data-link figc4.6 UA-received path raises MDL-NEGOTIATE Request on a v2.2
 * connect; the MDL driver ({@link Ax25ManagementDataLink}) then runs the single
 * XID command/response exchange and applies the §6.3.2 reverts-to merge,
 * replacing the forced establishment defaults with negotiated values.
 *
 * Mirrors the mod128-establishment suite's rigor: asserts on the negotiated
 * values landing in both contexts, the MDL state transitions, the MDL signals
 * raised, and the version-2.0 fallback / error paths.
 */
import { describe, expect, it } from "vitest";
import { type Ax25Frame, frmr, isCommand, isResponse, xid } from "../../src/frame.js";
import type { MdlSignal } from "../../src/sdl/action-dispatcher.js";
import { encodeXid, octetsToBits, type XidParameters } from "../../src/xid.js";
import { type Endpoint, TwoStationHarness } from "./two-station-harness.js";

const XID_BASE = 0xaf; // XID U-frame control, P/F masked out.
const isXid = (f: Ax25Frame): boolean => (f.control & 0xef) === XID_BASE;

/** MDL-ERROR Indicate codes raised by `e`, in order. */
function errorCodes(e: Endpoint): string[] {
  return e.mdlSignals
    .filter((s): s is Extract<MdlSignal, { type: "MDL_ERROR_indicate" }> =>
      s.type === "MDL_ERROR_indicate",
    )
    .map((s) => s.code);
}

/** Count of MDL-NEGOTIATE Confirm signals raised by `e`. */
function confirms(e: Endpoint): number {
  return e.mdlSignals.filter((s) => s.type === "MDL_NEGOTIATE_confirm").length;
}

/**
 * A full mod-128 + SREJ XID offer (half-duplex, k=32, N1=256, T1=3000ms,
 * N2=10) — the v2.2 baseline a station advertises. Tests vary one field via
 * spread to pin a specific reverts-to outcome.
 */
const MOD128_OFFER: XidParameters = {
  classesOfProcedures: { halfDuplex: true },
  hdlcOptionalFunctions: {
    reject: "selective",
    modulo128: true,
    srejMultiframe: false,
    segmenterReassembler: false,
  },
  iFieldLengthRxBits: octetsToBits(256),
  windowSizeRx: 32,
  ackTimerMillis: 3000,
  retries: 10,
};

describe("v2.2 arc V3 part 2 — MDL XID parameter negotiation", () => {
  // ─── Happy-path negotiation (two v2.2 stations) ─────────────────────────

  // 1 — two v2.2 stations connect; the initiator's figc4.6 UA path fires
  // MDL-NEGOTIATE Request, the MDL exchanges XID command/response, and both
  // stations end in MDL Ready having confirmed the negotiation. An XID command
  // and response actually crossed the wire.
  it("a v2.2 connect runs the XID exchange and confirms on both sides", () => {
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8 });
    h.connect();

    // Both MDL machines settle back in Ready (the exchange completed).
    expect(h.a.mdlState).toBe("Ready");
    expect(h.b.mdlState).toBe("Ready");

    // The initiator (A) confirmed negotiation to its Layer 3.
    expect(confirms(h.a)).toBe(1);

    // An XID command (from A) and an XID response (from B) crossed the link.
    expect(h.b.receivedFromPeer.some((f) => isXid(f) && isCommand(f))).toBe(true);
    expect(h.a.receivedFromPeer.some((f) => isXid(f) && isResponse(f))).toBe(true);
  });

  // 2 — the negotiated reject scheme reverts to the LESSER of the two offers
  // (§6.3.2 ¶1426): SREJ only survives if both sides offer it. Here the
  // responder offers only implicit reject, so both converge on REJ even though
  // the initiator offered SREJ.
  it("reject scheme reverts to the lesser REJ when one side offers only REJ", () => {
    const offerB: XidParameters = {
      ...MOD128_OFFER,
      hdlcOptionalFunctions: {
        reject: "implicit",
        modulo128: true,
        srejMultiframe: false,
        segmenterReassembler: false,
      },
    };
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 8,
      xidOfferA: MOD128_OFFER,
      xidOfferB: offerB,
    });

    h.connect();

    expect(h.a.context.srejEnabled).toBe(false); // SREJ reverts to the lesser
    expect(h.b.context.srejEnabled).toBe(false);
    expect(h.a.context.implicitReject).toBe(true);
    expect(h.b.context.implicitReject).toBe(true);
    // Modulo survives (both offered mod-128).
    expect(h.a.context.isExtended).toBe(true);
    expect(h.b.context.isExtended).toBe(true);
  });

  // 3 — window k reverts to notification/min (§6.3.2 ¶1430): each side adopts
  // the smaller of the two advertised Rx windows.
  it("window k converges on the minimum advertised", () => {
    const offerB: XidParameters = { ...MOD128_OFFER, windowSizeRx: 10 };
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 32,
      xidOfferA: MOD128_OFFER,
      xidOfferB: offerB,
    });

    h.connect();

    expect(h.a.context.k).toBe(10); // k reverts to the min of the two advertised
    expect(h.b.context.k).toBe(10);
  });

  // 4 — T1 reverts to the greater and N2 reverts to the greater (§6.3.2
  // ¶1432/¶1434). The slower / more-patient values win on both sides.
  it("T1 and N2 revert to the greater offered", () => {
    const offerA: XidParameters = { ...MOD128_OFFER, ackTimerMillis: 1000, retries: 8 };
    const offerB: XidParameters = { ...MOD128_OFFER, ackTimerMillis: 4000, retries: 15 };
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 8,
      xidOfferA: offerA,
      xidOfferB: offerB,
    });

    h.connect();

    expect(h.a.context.t1vMs).toBe(4000); // T1 reverts to the greater
    expect(h.b.context.t1vMs).toBe(4000);
    expect(h.a.context.n2).toBe(15); // N2 reverts to the greater
    expect(h.b.context.n2).toBe(15);
  });

  // 5 — modulo reverts to the lesser (§6.3.2 ¶1426): if one side offers only
  // mod-8 in the XID, both converge on mod-8.
  it("modulo reverts to mod-8 when one side offers only mod-8", () => {
    const offerB: XidParameters = {
      ...MOD128_OFFER,
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: false,
        srejMultiframe: false,
        segmenterReassembler: false,
      },
    };
    const h = TwoStationHarness.build({
      extended: true,
      srej: true,
      k: 8,
      xidOfferA: MOD128_OFFER,
      xidOfferB: offerB,
    });

    h.connect();

    expect(h.a.context.isExtended).toBe(false); // modulo reverts to the lesser (mod-8)
    expect(h.b.context.isExtended).toBe(false);
  });

  // ─── v2.0 fallback (pre-v2.2 peer FRMRs the XID command) ────────────────

  // 6 — a pre-v2.2 peer answers the XID command with FRMR (§6.3.2 ¶1): the MDL
  // applies the FULL §1436 version-2.0 default set (half-duplex, implicit
  // reject, mod-8, N1=256, k=7, T1=3000ms, N2=10), confirms, and the link is
  // usable at mod-8.
  it("FRMR of the XID command applies the full v2.0 defaults", () => {
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8 });

    // Swallow the XID command so the (modelled pre-v2.2) peer never auto-
    // responds; we inject the FRMR it would have sent. Start the negotiation
    // directly (a connect would have B auto-respond as a v2.2 peer).
    h.dropWhen(
      (f) =>
        isXid(f) &&
        isCommand(f) &&
        f.source.callsign.toString() === h.a.context.local.toString(),
    );
    h.startNegotiation(h.a);

    expect(h.a.mdlState).toBe("Negotiating"); // the XID command was swallowed

    // The pre-v2.2 peer rejects the XID command with a FRMR-of-XID. In
    // production the listener routes a FRMR to the MDL while it negotiates; here
    // we drive that boundary directly.
    h.a.mdl.onFrmrReceived(
      frmr({
        destination: h.a.context.local,
        source: h.a.context.remote,
        info: Uint8Array.from([0x00, 0x00, 0x00]),
      }),
    );

    // Full §1436 version-2.0 default set applied to A's link context.
    expect(h.a.context.isExtended).toBe(false); // v2.0 ⇒ modulo 8
    expect(h.a.context.srejEnabled).toBe(false); // v2.0 ⇒ implicit reject (no SREJ)
    expect(h.a.context.implicitReject).toBe(true);
    expect(h.a.context.n1).toBe(256); // v2.0 N1 = 2048 bits = 256 octets (§1436)
    expect(h.a.context.k).toBe(7); // v2.0 Window Size Receive = 7 (§1436)
    expect(h.a.context.n2).toBe(10); // v2.0 Retries = 10 (§1436)
    expect(h.a.context.halfDuplex).toBe(true); // v2.0 ⇒ half duplex (§1436)
    expect(h.a.context.t1vMs).toBe(3000); // v2.0 Acknowledge Timer = 3000 ms (§1436)
    expect(h.a.context.segmenterReassemblerEnabled).toBe(false); // v2.2-only

    // MDL confirms completion (a v2.0 connection is made) and returns to Ready.
    expect(h.a.mdlState).toBe("Ready");
    expect(confirms(h.a)).toBe(1);
  });

  // ─── TM201 retry / NM201 exhaustion (error C) ───────────────────────────

  // 7 — when no reply comes, TM201 retransmits the XID command up to NM201
  // times, then gives up with MDL-ERROR Indicate (C) ("management retry limit
  // exceeded", §C5.3).
  it("TM201 exhaustion gives up with MDL-ERROR (C)", () => {
    // NM201 defaults to the data-link N2 (here 3 for a short test). Drop ALL of
    // A's XID commands so the peer never replies; A must retry then fail.
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8, n2: 3 });
    h.dropWhen(
      (f) =>
        isXid(f) && f.source.callsign.toString() === h.a.context.local.toString(),
    );

    h.startNegotiation(h.a);
    expect(h.a.mdlState).toBe("Negotiating");

    // Retransmit cycles: each TM201 expiry with RC < NM201 bumps RC and resends.
    // NM201 == 3, so after 3 retries RC == NM201 and the next expiry gives up.
    for (let i = 0; i < 4; i++) h.advanceTm201();

    expect(h.a.mdlState).toBe("Ready"); // after NM201 retries the MDL gives up
    expect(errorCodes(h.a)).toContain("C"); // retry-limit exhaustion → MDL-ERROR (C)
  });

  // ─── Error D (XID response without F=1) ─────────────────────────────────

  // 8 — an XID response without F=1 is the error-D condition (§C5.3):
  // MDL-ERROR Indicate (D) is raised, and the MDL stays in Negotiating (TM201
  // still running) rather than completing.
  it("an XID response without F=1 raises MDL-ERROR (D) and stays negotiating", () => {
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8 });

    // Swallow A's XID command so the v2.2 peer doesn't auto-respond; inject a
    // crafted XID *response* with F=0.
    h.dropWhen(
      (f) =>
        isXid(f) &&
        isCommand(f) &&
        f.source.callsign.toString() === h.a.context.local.toString(),
    );
    h.startNegotiation(h.a);
    expect(h.a.mdlState).toBe("Negotiating");

    const info = encodeXid({
      hdlcOptionalFunctions: {
        reject: "selective",
        modulo128: true,
        srejMultiframe: false,
        segmenterReassembler: false,
      },
      windowSizeRx: 4,
    });
    const xidRespNoFinal = xid({
      destination: h.a.context.local,
      source: h.a.context.remote,
      info,
      isCommand: false,
      pollFinal: false,
    });

    h.a.mdl.onXidReceived(xidRespNoFinal);

    expect(errorCodes(h.a)).toContain("D"); // XID response without F=1 → MDL-ERROR (D)
    expect(h.a.mdlState).toBe("Negotiating"); // error D leaves the MDL negotiating
  });

  // ─── Error B (unexpected XID response in Ready) ─────────────────────────

  // 9 — an XID response arriving with no negotiation outstanding is the error-B
  // condition (§C5.3 "unexpected XID response"): MDL-ERROR Indicate (B),
  // staying in Ready.
  it("an unexpected XID response in Ready raises MDL-ERROR (B)", () => {
    const h = TwoStationHarness.build({ extended: true, srej: true, k: 8 });
    expect(h.a.mdlState).toBe("Ready"); // no negotiation has started

    const info = encodeXid({ windowSizeRx: 4 });
    const xidResp = xid({
      destination: h.a.context.local,
      source: h.a.context.remote,
      info,
      isCommand: false,
      pollFinal: true,
    });

    h.a.mdl.onXidReceived(xidResp);

    expect(errorCodes(h.a)).toContain("B"); // unexpected response → MDL-ERROR (B)
    expect(h.a.mdlState).toBe("Ready");
  });
});
