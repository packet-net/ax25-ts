/**
 * v2.2 arc V2 — SABME establishment + version negotiation. The TS parity leg of
 * packet.net's `Mod128EstablishmentConformanceTests` (PRs #268/#269).
 *
 * figc4.1/figc4.2 route the Disconnected DL-CONNECT-request unconditionally to
 * AwaitingConnection (no version branch — confirmed against the authoritative
 * graphml). The inlined `Establish_Data_Link` *does* send a SABME when the link
 * is extended (figc4.7's `mod_128` branch), so a v2.2-preferred connect emits
 * the right first frame but parks in the mod-8 establishment state, whose T1
 * retry downgrades to SABM and which has no FRMR handler. The
 * `ax25Spec44Mod128ConnectRoutesToV22` quirk (default on, ax25spec#44) rewrites
 * that single transition's target to AwaitingV22Connection (figc4.6), which
 * resends SABME on retry and handles the §975 FRMR/DM fallbacks. The
 * `ax25Spec45FrmrFallbackReestablishesV20` quirk (default on, ax25spec#45)
 * forces version 2.0 *before* the figc4.6 t14 FRMR actions run, so the §975
 * fallback re-establishes with a SABM (not a SABME — t14 draws Establish before
 * Set Version 2.0).
 *
 * These tests drive the full handshake end-to-end through the two-station
 * harness with the real driver, asserting the figc4.6 transitions fire and the
 * fallbacks behave — closing the AwaitingV22Connection behavioural-coverage gap
 * that existed because nothing could drive a SABME connect.
 */
import { describe, expect, it } from "vitest";
import type { Ax25Frame } from "../../src/frame.js";
import type { Endpoint } from "./two-station-harness.js";
import { TwoStationHarness } from "./two-station-harness.js";

// U-frame base control octets (P/F bit 4 masked out) — what the receiver sees.
const SABME_BASE = 0x6f;
const SABM_BASE = 0x2f;
const FRMR_CONTROL = 0x87; // FRMR U-frame control octet (§4.3.3.9).

const uBase = (f: Ax25Frame): number => f.control & 0xef;
const isSabme = (f: Ax25Frame): boolean => uBase(f) === SABME_BASE;
const isSabm = (f: Ax25Frame): boolean => uBase(f) === SABM_BASE;

/**
 * A FRMR frame addressed to `target` — the §975 rejection a pre-v2.2 peer sends
 * in response to a SABME. Built inline (no `frmr` factory yet); the figc4.6 t14
 * handler reads no frame fields (it only runs Establish + Set Version 2.0), so a
 * minimal FRMR-shaped frame suffices. Source/destination are set so the frame is
 * "from the remote, to us", matching a real inbound rejection.
 */
function frmrToward(target: Endpoint): Ax25Frame {
  return {
    destination: {
      callsign: target.context.local,
      crhBit: false,
      extensionBit: false,
    },
    source: {
      callsign: target.context.remote,
      crhBit: true,
      extensionBit: true,
    },
    digipeaters: [],
    control: FRMR_CONTROL,
    controlExtension: null,
    pid: null,
    info: Uint8Array.from([0x00, 0x00, 0x00]),
  };
}

/** A DM(F=1) frame addressed to `target` — the §975 rejection a not-capable
 * peer sends in response to a SABME. */
function dmFinalToward(target: Endpoint): Ax25Frame {
  return {
    destination: {
      callsign: target.context.local,
      crhBit: false,
      extensionBit: false,
    },
    source: {
      callsign: target.context.remote,
      crhBit: true,
      extensionBit: true,
    },
    digipeaters: [],
    control: 0x0f | 0x10, // DM with F=1 (CONTROL_DM | CONTROL_PF_BIT).
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

describe("v2.2 arc V2 — mod-128 establishment + version negotiation", () => {
  // 1 — a mod-128 connect routes the initiator through AwaitingV22Connection
  // (figc4.6), and both stations reach Connected with isExtended. Proven on the
  // live firedTransitions ledger.
  it("mod-128 connect routes the initiator through AwaitingV22Connection", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });

    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();

    // The initiator transited the figc4.6 AwaitingV22Connection state: its
    // DL-CONNECT left Disconnected via t03, and the connection completed via the
    // figc4.6 UA-received transition — a transition that exists ONLY in
    // AwaitingV22Connection, so its firing proves the route.
    expect(h.firedTransition("Disconnected", "t03_dl_connect_request")).toBe(
      true,
    );
    expect(
      h.firedTransition("AwaitingV22Connection", "t12_ua_received_yes_yes"),
    ).toBe(true);
    // A mod-128 connect must NOT complete through the mod-8 figc4.2
    // AwaitingConnection state.
    expect(
      h.firedTransition("AwaitingConnection", "t04_ua_received_yes_yes"),
    ).toBe(false);

    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
    expect(h.a.context.isExtended).toBe(true); // initiator negotiated mod-128
    expect(h.b.context.isExtended).toBe(true); // responder adopted mod-128 (figc4.1 t14)

    // The first frame the responder saw was a SABME, not a SABM.
    expect(h.b.receivedFromPeer.some(isSabme)).toBe(true);
    expect(h.b.receivedFromPeer.some(isSabm)).toBe(false);
  });

  // 2 — when the initial SABME is lost, the T1 retry resends a SABME (figc4.6
  // t13_t1_expiry_no), NOT a SABM. The mis-routed figc4.2 path would downgrade
  // the link to mod-8 on the first retry; the redirect prevents that.
  it("a lost SABME is retried as SABME, not downgraded to SABM", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });

    // Drop the initial SABME on the channel so the responder never answers and
    // the initiator must retry from AwaitingV22Connection. (Drop SABMEs from A
    // only; leave everything else flowing.)
    let dropped = 0;
    h.dropWhen((f) => {
      if (
        isSabme(f) &&
        f.source.callsign.toString() === h.a.context.local.toString() &&
        dropped === 0
      ) {
        dropped++;
        return true;
      }
      return false;
    });

    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();

    expect(h.a.state).toBe("AwaitingV22Connection");
    expect(dropped).toBe(1);
    expect(h.b.receivedFromPeer).toHaveLength(0); // the only frame so far (SABME) was dropped

    // T1 fires → figc4.6 t13_t1_expiry_no: RC++, resend SABME (P=1), restart T1.
    h.advanceT1();

    expect(
      h.firedTransition("AwaitingV22Connection", "t13_t1_expiry_no"),
    ).toBe(true);
    expect(h.b.receivedFromPeer.length).toBeGreaterThan(0); // retry delivered
    // Every establishment frame the responder sees is a SABME — the link did
    // NOT downgrade to mod-8.
    expect(h.b.receivedFromPeer.every(isSabme)).toBe(true);
    expect(h.b.receivedFromPeer.some(isSabm)).toBe(false);

    // And it converges to a mod-128 connection.
    h.settle();
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
    expect(h.a.context.isExtended).toBe(true);
    expect(h.b.context.isExtended).toBe(true);
  });

  // 3 — a pre-v2.2 peer answers a SABME with FRMR (§975): the initiator falls
  // back to v2.0 and re-establishes with a SABM, completing a mod-8 connection.
  // figc4.6 t14_frmr_received forces Version 2.0 (ax25spec#45) and
  // re-establishes; the #44 redirect is what makes that handler reachable
  // (figc4.2's AwaitingConnection, where a mod-128 connect used to land, has no
  // FRMR handler at all). The re-establish-as-SABM half depends on the #45 fix:
  // t14 draws Establish before Set Version 2.0, so without #45 the re-establish
  // would be a SABME while still extended.
  it("a FRMR to a SABME falls back to v2.0 and re-establishes with SABM", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });

    // Drop only the initiator's SABME, so the v2.2 peer never sees it (never
    // adopts mod-128); the SABM the fallback re-establishes with passes through
    // and completes a mod-8 connection. We inject the FRMR a pre-v2.2 peer would
    // have sent in response to that (dropped-here) SABME.
    h.dropWhen(
      (f) =>
        isSabme(f) &&
        f.source.callsign.toString() === h.a.context.local.toString(),
    );

    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    expect(h.a.state).toBe("AwaitingV22Connection");
    expect(h.a.context.isExtended).toBe(true); // still v2.2 until the FRMR arrives

    // The pre-v2.2 peer rejects the SABME.
    h.inject(h.a, { name: "FRMR_received", frame: frmrToward(h.a) });

    // The FRMR runs the figc4.6 §975 fallback transition — reachable only
    // because the #44 redirect parked the connect here.
    expect(h.firedTransition("AwaitingV22Connection", "t14_frmr_received")).toBe(
      true,
    );
    // ax25spec#45 fix: Version 2.0 forced before Establish, so the re-establish
    // is a SABM (not SABME).
    expect(h.b.receivedFromPeer.some(isSabm)).toBe(true);
    expect(h.b.receivedFromPeer.some(isSabme)).toBe(false);
    expect(h.a.context.isExtended).toBe(false); // fell back to mod-8
    expect(h.a.state).toBe("Connected"); // the v2.0 SABM re-establish completed
    expect(h.b.state).toBe("Connected");
    // The peer adopted mod-8 from the SABM (figc4.1 SABM-received → set_version_2_0).
    expect(h.b.context.isExtended).toBe(false);
  });

  // 4 — a not-capable peer answers a SABME with DM (§975 DM case). figc4.6
  // t11_dm_received_yes tears the connect attempt down to Disconnected and
  // indicates DL-DISCONNECT.
  it("a DM to a SABME tears the connect attempt down to Disconnected", () => {
    const h = TwoStationHarness.build({ extended: true, k: 8 });

    // Swallow the SABME so the v2.2 peer never auto-UAs; inject the DM(F=1) a
    // not-capable peer would send.
    h.dropWhen(
      (f) =>
        isSabme(f) &&
        f.source.callsign.toString() === h.a.context.local.toString(),
    );

    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    expect(h.a.state).toBe("AwaitingV22Connection");

    h.inject(h.a, { name: "DM_received", frame: dmFinalToward(h.a) });

    expect(
      h.firedTransition("AwaitingV22Connection", "t11_dm_received_yes"),
    ).toBe(true);
    expect(h.a.state).toBe("Disconnected"); // the not-capable DM abandons the connect
    // Teardown indicates DL-DISCONNECT to the upper layer.
    expect(
      h.a.signals.some((s) => s.type === "DL_DISCONNECT_indication"),
    ).toBe(true);
  });

  // StrictlyFaithful reproduces the figure defect: a mod-128 connect parks in
  // AwaitingConnection (the mod-8 state) and its retry downgrades to SABM. Pins
  // the quirk's off-behaviour so the redirect stays a deliberate, named
  // deviation.
  it("strictlyFaithful reproduces the figc4.2 defect (parks in AwaitingConnection, downgrades on retry)", () => {
    const h = TwoStationHarness.buildStrictlyFaithful({ extended: true, k: 8 });

    // Drop the first SABME so we can observe the retry's frame type.
    let dropped = 0;
    h.dropWhen((f) => {
      if (
        isSabme(f) &&
        f.source.callsign.toString() === h.a.context.local.toString() &&
        dropped === 0
      ) {
        dropped++;
        return true;
      }
      return false;
    });

    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();

    // Faithful figure: the redirect is off, so the initiator parks in the mod-8
    // establishment state despite having sent a SABME.
    expect(h.a.state).toBe("AwaitingConnection");

    // And its T1 retry downgrades to SABM (the second consequence of the defect).
    h.advanceT1();
    expect(h.b.receivedFromPeer.some(isSabm)).toBe(true);
  });
});
