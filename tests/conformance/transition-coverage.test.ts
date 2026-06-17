/**
 * Behavioural transition-coverage ledger. Runs a battery of representative
 * scenarios through the two-station harness with the **real** dispatcher and
 * records, via each driver's `onTransitionFired` hook (surfaced on the harness
 * as {@link TwoStationHarness.firedTransition}), which `(state, transition-id)`
 * pairs actually execute. Reports per-state coverage against the live `ax25sdl`
 * tables and asserts that a curated set of high-value transitions across every
 * state is behaviourally exercised, plus a floor on the total — so behavioural
 * coverage is measurable and can't silently regress.
 *
 * The TypeScript parity leg of packet.net's `TransitionCoverageTests`
 * (v2.2 arc V5a — m0lte/packet.net#274; lifted in V5b to full reachable
 * coverage). Of the 250 tracked transitions (the six data-link states plus the
 * management_data_link Ready/Negotiating machine, added to the ledger in V5a via
 * the MDL driver's forwarded transition-fired hook), this measures which the real
 * runtime runs when driven through realistic traffic. The battery runs both mod-8
 * and mod-128 (extended) scenarios — bidirectional data incl. a 127→0
 * window-wrap, REJ/SREJ loss recovery, RNR flow, T3 keepalive, the Connected and
 * TimerRecovery receive columns by frame-injection, the establishment/release
 * receive + primitive + error-input columns, XID negotiation, and segmentation
 * over a mod-128 link. As of V5b the battery drives every REACHABLE transition
 * (238/250); the 12 remaining misses are genuinely unreachable through the real
 * runtime — the canTransmitIFrame-gated I-frame-pop variants (packet.net#263),
 * the command-only I-frame's nonexistent I-response columns, and the
 * !T1_running-in-TimerRecovery flow-on branch. They are enumerated at the
 * coverage assertion below.
 *
 * This complements the structural smoke coverage (`sdl-driver.test.ts`) and the
 * scenario suites (happy-path / loss-recovery / mod128 / mdl / segmentation),
 * which assert correctness. Here the question is the orthogonal one: of the
 * tracked transitions, which does the real runtime actually run?
 *
 * Membership is queried through each rig's public
 * {@link TwoStationHarness.firedTransition} predicate, OR'd over every collected
 * rig — so the battery never reconstructs the harness's internal key format.
 */
import { describe, expect, it } from "vitest";
import {
  DataLinkAwaitingConnection,
  DataLinkAwaitingRelease,
  DataLinkAwaitingV22Connection,
  DataLinkConnected,
  DataLinkDisconnected,
  DataLinkTimerRecovery,
  ManagementDataLinkNegotiating,
  ManagementDataLinkReady,
  type StatePage,
} from "ax25sdl";
import {
  type Ax25Frame,
  classify,
  disc,
  dm,
  frmr,
  getNs,
  iFrame,
  rej,
  rnr,
  rr,
  sabm,
  sabme,
  srej,
  ua,
  ui,
  xid,
} from "../../src/frame.js";
import { defaultSessionQuirks } from "../../src/sdl/session-quirks.js";
import { encodeXid } from "../../src/xid.js";
import type { Endpoint } from "./two-station-harness.js";
import { TwoStationHarness } from "./two-station-harness.js";

/** A `(from, id) → fired?` predicate, OR'd over every collected rig. */
type FiredQuery = (from: string, id: string) => boolean;

// The tracked state→table set, mirroring the C# `Tables` array. The
// management_data_link Ready/Negotiating machine joins the ledger (V5a); its
// state names don't collide with the data-link states.
const TABLES: ReadonlyArray<readonly [string, StatePage]> = [
  ["Disconnected", DataLinkDisconnected],
  ["AwaitingConnection", DataLinkAwaitingConnection],
  ["AwaitingV22Connection", DataLinkAwaitingV22Connection],
  ["Connected", DataLinkConnected],
  ["AwaitingRelease", DataLinkAwaitingRelease],
  ["TimerRecovery", DataLinkTimerRecovery],
  ["Ready", ManagementDataLinkReady],
  ["Negotiating", ManagementDataLinkNegotiating],
];

// ─── Frame builders (addressed to the target, i.e. "from its peer") ──────────

const frmrTo = (t: Endpoint): Ax25Frame =>
  frmr({
    destination: t.context.local,
    source: t.context.remote,
    info: Uint8Array.from([0x00, 0x00, 0x00]),
  });

const dmTo = (t: Endpoint, finalBit = false): Ax25Frame =>
  dm({ destination: t.context.local, source: t.context.remote, finalBit });

const discTo = (t: Endpoint): Ax25Frame =>
  disc({ destination: t.context.local, source: t.context.remote });

const sabmTo = (t: Endpoint): Ax25Frame =>
  sabm({ destination: t.context.local, source: t.context.remote });

const sabmeTo = (t: Endpoint): Ax25Frame =>
  sabme({ destination: t.context.local, source: t.context.remote });

const uaTo = (t: Endpoint, finalBit: boolean): Ax25Frame =>
  ua({ destination: t.context.local, source: t.context.remote, finalBit });

const uiTo = (t: Endpoint, info: string, pollFinal = false): Ax25Frame =>
  ui({
    destination: t.context.local,
    source: t.context.remote,
    info: new TextEncoder().encode(info),
    pollFinal,
  });

// Extended (mod-128) supervisory / I-frame builders (2-octet control), used by
// the TimerRecovery injection block to hit specific figc4.5 receive branches.
const rrExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rr({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const rnrExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rnr({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const rejExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rej({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const srejExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  srej({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const iExt = (t: Endpoint, nr: number, ns: number, payload: number, pf: boolean): Ax25Frame =>
  iFrame({
    destination: t.context.local,
    source: t.context.remote,
    nr,
    ns,
    info: Uint8Array.from([payload]),
    pollBit: pf,
    extended: true,
  });

// ─── Channel-policy predicates (mirror the C# inline drop lambdas) ───────────

const fromA = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  f.source.callsign.toString() === h.a.context.local.toString();
const fromB = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  f.source.callsign.toString() === h.b.context.local.toString();
const isI = (f: Ax25Frame): boolean => classify(f) === "I";
const isSabmOrSabme = (f: Ax25Frame): boolean =>
  classify(f) === "SABM" || classify(f) === "SABME";
const isSupervisoryAck = (f: Ax25Frame): boolean =>
  classify(f) === "RR" || classify(f) === "RNR";
const isXidFromA = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  classify(f) === "XID" && fromA(h, f);

/**
 * Build a coverage harness — the oracle (per-step invariant check) is suspended
 * because the injection scenarios post frames outside the submitted/delivered
 * model; correctness is asserted by the dedicated conformance suites, this
 * battery measures only which transitions fire. Mirrors the C# `New(...)`.
 */
function New(opts: {
  srej?: boolean;
  k?: number;
  extended?: boolean;
  n2?: number;
  segmenter?: boolean;
  n1?: number;
} = {}): TwoStationHarness {
  const h = TwoStationHarness.build(opts);
  h.checkAfterEachStep = false;
  return h;
}

/**
 * An extended-connect rig with ONLY ax25Spec48DmRejectionDegradesToV20 turned
 * off (Spec44 still on, so the connect reaches AwaitingV22Connection). Used to
 * exercise the figure-literal figc4.6 DM-received transitions (t11_dm_received_yes
 * teardown / t11_dm_received_no drop) that the default-on Spec48 degrade rewrites
 * to t14_frmr_received. Mirrors the C# `Default with { Ax25Spec48… = false }`
 * coverage rigs.
 */
function dmDegradeOffRig(): TwoStationHarness {
  const h = TwoStationHarness.build({
    extended: true,
    quirks: { ...defaultSessionQuirks, ax25Spec48DmRejectionDegradesToV20: false },
  });
  h.checkAfterEachStep = false;
  return h;
}

/**
 * Run the full battery and return a `(from, id) → fired?` predicate OR'd over
 * every rig. Mirrors the C# `RunBatteryAndCollectFired` (which returns a
 * HashSet; here membership rides on each rig's `firedTransition` to avoid
 * reconstructing the harness's internal key format).
 */
function runBatteryAndCollectFired(): FiredQuery {
  const rigs: TwoStationHarness[] = [];
  const collect = (h: TwoStationHarness): void => {
    rigs.push(h);
  };

  // 1. Connect (from A) + clean disconnect.
  {
    const h = New();
    h.connect();
    h.disconnect(h.a);
    collect(h);
  }

  // 2. Connect initiated by B.
  {
    const h = New();
    h.connectFrom(h.b);
    h.disconnect(h.b);
    collect(h);
  }

  // 3. Bidirectional data transfer + delayed-ack flush.
  {
    const h = New();
    h.connect();
    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();
    h.flushAcks();
    collect(h);
  }

  // 4. Window-full transfer that wraps the modulus.
  {
    const h = New({ k: 4 });
    h.connect();
    for (let i = 0; i < 12; i++) h.submit(h.a, i);
    h.flushAcks();
    collect(h);
  }

  // 5. Single-drop REJ recovery (Connected → TimerRecovery → recover).
  {
    const h = New({ k: 4 });
    h.connect();
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f)) {
        dropped = true;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 4; i++) h.submit(h.a, i);
    h.recoverUntilConverged(30);
    collect(h);
  }

  // 6. SREJ recovery under intermittent loss.
  {
    const h = New({ srej: true, k: 4 });
    h.connect();
    let budget = 2;
    h.dropWhen((f) => {
      if (budget > 0 && fromA(h, f) && isI(f)) {
        budget--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);
    collect(h);
  }

  // 7. RNR flow control (peer-receiver-busy → RNR → resume).
  {
    const h = New({ k: 4 });
    h.connect();
    h.submit(h.a, 0x01);
    h.setBusy(h.b);
    h.submit(h.a, 0x02);
    h.clearBusy(h.b);
    h.flushAcks();
    collect(h);
  }

  // 8. Sustained loss → N2 exhaustion → disconnect from TimerRecovery.
  {
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x01);
    for (let r = 0; r < 20 && h.a.state !== "Disconnected"; r++) h.advanceT1();
    collect(h);
  }

  // 9. FRMR + DM received in Connected and TimerRecovery.
  {
    const h = New({ k: 4 });
    h.connect();
    h.injectFrameBytes(h.a, frmrTo(h.a)); // → re-establish
    h.injectFrameBytes(h.a, dmTo(h.a)); // → teardown
    collect(h);
  }
  {
    // Drive into TimerRecovery, then inject a REJ receive-column frame.
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x00);
    h.advanceT1();
    h.dropWhen(undefined);
    h.injectFrameBytes(
      h.a,
      rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, isCommand: false, pollFinal: true }),
    );
    collect(h);
  }
  {
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x00);
    h.advanceT1();
    h.injectFrameBytes(h.a, frmrTo(h.a)); // FRMR in TimerRecovery
    collect(h);
  }

  // 10. mod-128 (extended) establishment — the figc4.6 AwaitingV22Connection
  // column. The ax25Spec44 redirect routes a v2.2-preferred connect here, so
  // this is the battery that lifts AwaitingV22Connection off 0/25.

  // 10a. Happy path: SABME → UA → Connected (mod-128), data, clean disconnect.
  {
    const h = New({ extended: true });
    h.connect();
    h.submit(h.a, 0xc0);
    h.flushAcks();
    h.disconnect(h.a);
    collect(h);
  }

  // 10b. Lost SABME → T1 retry RESENDS SABME (t13_t1_expiry_no), then converges.
  {
    const h = New({ extended: true });
    let dropped = 0;
    h.dropWhen((f) => {
      if (classify(f) === "SABME" && fromA(h, f) && dropped === 0) {
        dropped++;
        return true;
      }
      return false;
    });
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    h.advanceT1(); // t13_t1_expiry_no → resend SABME → UA → Connected
    collect(h);
  }

  // 10c. §975 FRMR fallback (t14_frmr_received): peer rejects SABME → set
  // version 2.0, re-establish, fall to AwaitingConnection.
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, frmrTo(h.a));
    collect(h);
  }

  // 10d. Receive-column odds that STAY in AwaitingV22Connection: a redundant
  // DL-CONNECT (t02), DL-UNIT-DATA (t03), a layer-3-initiated DL-DATA (t04_yes —
  // a no-op buffer that does NOT queue, so it's safe), UI received (t10_no /
  // t10_yes), a UA with F=0 (t12_ua_received_no → DL-ERROR D), a SABME collision
  // (t15_sabme_received → UA), a DISC (t17_disc_received). All keep A parked, so
  // they share one rig (establishment frames swallowed so the peer never UAs us
  // out of the state).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") {
      h.a.driver.postEvent({ name: "DL_CONNECT_request" }); // t02
      h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); // t03
      h.a.driver.postEvent({ name: "DL_DATA_request", data: Uint8Array.from([0x02]), pid: 0xf0 }); // t04_yes (no queue)
      h.settle();
      h.injectFrameBytes(h.a, uiTo(h.a, "y")); // t10_ui_received_no
      h.injectFrameBytes(h.a, uiTo(h.a, "z", true)); // t10_ui_received_yes
      h.injectFrameBytes(h.a, uaTo(h.a, false)); // t12_ua_received_no → DL-ERROR D, stay
      h.injectFrameBytes(h.a, sabmeTo(h.a)); // t15_sabme_received → UA, stay
      h.injectFrameBytes(h.a, discTo(h.a)); // t17_disc_received → stay
    }
    collect(h);
  }

  // 10d-i. DM(F=1) tears the v2.2 connect down (t11_dm_received_yes →
  // Disconnected). This is the FIGURE-LITERAL path, which only fires with
  // ax25Spec48 OFF now: by default ax25Spec48DmRejectionDegradesToV20 rewrites a
  // DM to the FRMR-fallback (t14_frmr_received) so a DM-ing peer (XRouter)
  // degrades to v2.0 instead of failing. Turn off ONLY Spec48 (keep Spec44 on so
  // the connect still reaches AwaitingV22Connection — full strictlyFaithful would
  // park it in the mod-8 AwaitingConnection state). Mirrors C# rig 10d-i.
  {
    const h = dmDegradeOffRig();
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, dmTo(h.a, true));
    collect(h);
  }

  // 10d-i-bis. DM(F=1) DEGRADES to v2.0 by default (ax25Spec48): the same DM that
  // the Spec48-off rig above tore down now runs t14_frmr_received (force v2.0 →
  // Establish via SABM → AwaitingConnection). Default-on rig. Mirrors C#
  // rig 10d-i-bis.
  {
    const h = New({ extended: true });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, dmTo(h.a, true));
    collect(h);
  }

  // 10d-ii. DM(F=0) drops to the mod-8 AwaitingConnection state
  // (t11_dm_received_no). Figure-literal path — with ax25Spec48 off (by default
  // Spec48 degrades this to t14 too). Keep Spec44 on so the connect reaches
  // AwaitingV22Connection. Mirrors C# rig 10d-ii.
  {
    const h = dmDegradeOffRig();
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, dmTo(h.a, false));
    collect(h);
  }

  // 10d-iii. SABM(v2.0) received while awaiting v2.2 → UA, set version 2.0,
  // drop to AwaitingConnection (t16_sabm_received).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, sabmTo(h.a));
    collect(h);
  }

  // 10e. N2 exhaustion while awaiting the v2.2 connection (t13_t1_expiry_yes).
  {
    const h = New({ extended: true, n2: 2 });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    for (let r = 0; r < 6 && h.a.state === "AwaitingV22Connection"; r++) h.advanceT1();
    collect(h);
  }

  // 11. Disconnected-state receive column: deliver assorted frames to a station
  // with no session up (figc4.1 receive handling — UI, DISC→DM, spurious UA).
  {
    const h = New();
    h.injectFrameBytes(h.a, uiTo(h.a, "x"));
    h.injectFrameBytes(h.a, discTo(h.a));
    h.injectFrameBytes(h.a, uaTo(h.a, true)); // spurious UA
    collect(h);
  }

  // 12. AwaitingConnection receive column: hold A there (drop B's UA), walk the
  // non-terminal receives, finish by abandoning on a DM(F=1).
  {
    const h = New();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingConnection") {
      h.injectFrameBytes(h.a, dmTo(h.a, false)); // DM F=0 → stay
      h.injectFrameBytes(h.a, discTo(h.a)); // DISC → stay
      // figc4.3 t09 — buffer-while-connecting: a DL_DATA_request in
      // AwaitingConnection buffers the frame on the I-frame queue rather than
      // sending it (the canTransmitIFrame state gate stops the post-dispatch
      // drain from popping it pre-connect; it would drain once Connected). This
      // used to throw before the gate — the TS↔C# parity fix mirroring packet.net#263.
      h.a.driver.postEvent({ name: "DL_DATA_request", data: new Uint8Array([0x42]), pid: 0xf0 });
      h.advanceT1(); // T1 → retransmit SABM
      h.injectFrameBytes(h.a, dmTo(h.a, true)); // DM F=1 → Disconnected
    }
    collect(h);
  }
  // 12b. AwaitingConnection T1 → N2 exhaustion (give up → Disconnected).
  {
    const h = New({ n2: 2 });
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    for (let r = 0; r < 6 && h.a.state === "AwaitingConnection"; r++) h.advanceT1();
    collect(h);
  }

  // 13. AwaitingRelease receive column: hold A there (drop B's UA to the DISC),
  // walk the non-terminal receives, finish on a UA(F=1).
  {
    const h = New();
    h.connect();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_DISCONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingRelease") {
      h.injectFrameBytes(h.a, uaTo(h.a, false)); // UA F=0 → stay
      h.injectFrameBytes(h.a, discTo(h.a)); // DISC → stay
      h.injectFrameBytes(h.a, sabmTo(h.a)); // SABM → stay
      h.advanceT1(); // T1 → retransmit DISC
      h.injectFrameBytes(h.a, uaTo(h.a, true)); // UA F=1 → Disconnected
    }
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v2.2 arc V5a — extended-mode (mod-128) behavioural coverage. Every block
  // below runs on an extended link, routed through AwaitingV22Connection by the
  // ax25Spec44 redirect, so the Connected / TimerRecovery N(S)/N(R)/N(R)-window
  // paths execute in the 7-bit sequence space. Logical transition ids are
  // mode-independent, so these lift coverage by reaching receive-column paths the
  // mod-8 battery never drives — and prove they hold at modulo-128.
  // ──────────────────────────────────────────────────────────────────────────

  // 14. mod-128 bidirectional data transfer + delayed-ack flush.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();
    h.flushAcks();
    collect(h);
  }

  // 15. mod-128 window-full transfer that WRAPS the 127→0 boundary. Seed both
  // ends near the top of the 7-bit ring and transfer a burst across the wrap.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    const seed = 124;
    h.a.context.vs = h.a.context.va = h.a.context.vr = seed;
    h.b.context.vs = h.b.context.va = h.b.context.vr = seed;
    for (let i = 0; i < 8; i++) h.submit(h.a, 0x40 + i); // N(S)=124..127,0..3
    h.flushAcks();
    collect(h);
  }

  // 16. mod-128 single-drop REJ recovery.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f) && getNs(f) === 1) {
        dropped = true;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 5; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);
    collect(h);
  }

  // 17. mod-128 SREJ recovery under intermittent loss (multi-frame).
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 40 });
    h.connect();
    let dropsLeft = 3;
    let seq = 0;
    h.dropWhen((f) => {
      // Deterministic stand-in for the C# `rng.NextDouble() < 0.6`: drop a few
      // I-frames from A on a fixed pattern (coverage, not statistics).
      if (dropsLeft > 0 && fromA(h, f) && isI(f) && seq++ % 2 === 0) {
        dropsLeft--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 8; i++) h.submit(h.a, i);
    h.recoverUntilConverged(60);
    collect(h);
  }

  // 18. mod-128 bidirectional loss recovery: both directions carry data AND lose
  // frames, so a station receives peer I/supervisory frames WHILE itself
  // recovering — the TimerRecovery I-received and RR/RNR receive columns.
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 40 });
    h.connect();
    let aDrops = 2;
    let bDrops = 2;
    h.dropWhen((f) => {
      if (!isI(f)) return false;
      if (aDrops > 0 && fromA(h, f) && getNs(f) === 1) {
        aDrops--;
        return true;
      }
      if (bDrops > 0 && fromB(h, f) && getNs(f) === 1) {
        bDrops--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 4; i++) {
      h.submit(h.a, 0xa0 + i);
      h.submit(h.b, 0xb0 + i);
    }
    h.recoverUntilConverged(60);
    collect(h);
  }

  // 18b. mod-128 TimerRecovery receive columns — fold the proven injection
  // technique into the ledger. Drive A into TimerRecovery with N unacked
  // extended I-frames (drop A's I-frames, expire T1), then inject a crafted
  // supervisory / I frame "from B" — reaching the figc4.5 RR/RNR/REJ/SREJ/I
  // receive branches in the 7-bit space.
  const inTimerRecovery128 = (outstanding: number, srejEnabled = false): TwoStationHarness => {
    const h = New({ extended: true, srej: srejEnabled, k: 8, n2: 40 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    for (let i = 0; i < outstanding; i++) h.submit(h.a, i);
    h.advanceT1(); // unacked I-frame's T1 → poll → TimerRecovery
    h.dropWhen(undefined);
    return h;
  };
  // RR response, F=1, N(R)=V(s) → completes recovery to Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rrExt(h.a, 1, false, true)); collect(h); }
  // RR command, P=1, in-window → A responds, stays recovering.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 1, true, true)); collect(h); }
  // RR response, F=0, in-window → bare ack, stays.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 1, false, false)); collect(h); }
  // RNR command, P=1, in-window → peer-busy + enquiry response, stays.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 1, true, true)); collect(h); }
  // RNR response, F=1, N(R)=V(s) → peer-busy, everything acked → Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rnrExt(h.a, 1, false, true)); collect(h); }
  // REJ command, P=1, N(R)=V(s) → retransmit + complete.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, true)); collect(h); }
  // REJ response, F=1, in-window, V(s)≠N(R) (partial) → stays recovering.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rejExt(h.a, 1, false, true)); collect(h); }
  // In-sequence I command (N(S)=V(R)), P=0 → deliver peer data while recovering.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0xbb, false)); collect(h); }
  // In-sequence I command, P=1 → deliver + enquiry response.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0xcc, true)); collect(h); }
  // Out-of-sequence I command (N(S)=V(R)+2, a gap) → REJ/SREJ the gap, stays.
  { const h = inTimerRecovery128(1, true); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xdd, false)); collect(h); }
  // SREJ response, in-window, F=1, V(s)=N(R) → selective retransmit + complete.
  { const h = inTimerRecovery128(1, true); h.injectFrameBytes(h.a, srejExt(h.a, 1, false, true)); collect(h); }
  // SREJ response, in-window, F=0 → selective retransmit, stays.
  { const h = inTimerRecovery128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 0, false, false)); collect(h); }
  // DISC received while recovering → teardown to Disconnected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, discTo(h.a)); collect(h); }
  // SABME collision while recovering (vs_eq_va false here) → resync to Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, sabmeTo(h.a)); collect(h); }
  // UI received while recovering (P=0 and P=1) → connectionless delivery, stays.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, uiTo(h.a, "r")); collect(h); }
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, uiTo(h.a, "s", true)); collect(h); }
  // DL primitives while recovering: redundant connect (t07), unit-data (t04),
  // flow-off/on (t05/t06), catch-all upper (t26) + lower (t25), control-field
  // error (t08).
  {
    const h = inTimerRecovery128(1);
    h.a.driver.postEvent({ name: "DL_CONNECT_request" }); // t07
    h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); // t04
    h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); // t05
    h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); // t06
    h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); // t26
    h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); // t25
    h.inject(h.a, { name: "control_field_error" }); // t08
    collect(h);
  }
  // N2 exhaustion from TimerRecovery with peer busy registered (the
  // RC_eq_N2 ∧ vs_eq_va ∧ peer_busy branch): mark peer busy, then starve.
  {
    const h = New({ extended: true, k: 8, n2: 2 });
    h.connect();
    h.injectFrameBytes(h.a, rnrExt(h.a, 0, true, true)); // peer busy
    h.dropWhen((f) => fromA(h, f)); // starve everything from A
    h.submit(h.a, 0x01);
    for (let r = 0; r < 8 && h.a.state !== "Disconnected"; r++) h.advanceT1();
    collect(h);
  }

  // 18c. More mod-128 TimerRecovery receive branches reachable by injection.
  // DM received while recovering → teardown.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, dmTo(h.a, true)); collect(h); }
  // LM-SEIZE-confirm in TimerRecovery, both ACK-pending branches.
  { const h = inTimerRecovery128(1); h.a.context.acknowledgePending = true; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  { const h = inTimerRecovery128(1); h.a.context.acknowledgePending = false; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  // REJ command (P=1) variants: in-window-not-complete and a fresh out-of-window
  // N(R) — the t23 command columns.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, true)); collect(h); }
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, false)); collect(h); }
  // SREJ command (P=1) → the t24 not-response columns.
  { const h = inTimerRecovery128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 0, true, true)); collect(h); }
  // RR command (P=1) with TWO outstanding, N(R)=0 (no ack).
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 0, true, true)); collect(h); }
  // RNR command (P=1), N(R)=0 — peer busy, no ack.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 0, true, true)); collect(h); }
  // Out-of-sequence I (no SREJ) → REJ go-back-N branch.
  { const h = inTimerRecovery128(1, false); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xee, false)); collect(h); }
  // Out-of-sequence I, P=1 → REJ + enquiry response.
  { const h = inTimerRecovery128(1, false); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xef, true)); collect(h); }

  // 18d. TimerRecovery entered IDLE (via T3 expiry with V(s)=V(a)) so the
  // vs_eq_va SABM/SABME-received branches are reachable, plus DL-DATA / flow
  // paths in the empty-window recovery state. Drop B's supervisory reply so A's
  // T3-poll gets no answer and STAYS in TimerRecovery with V(s)=V(a).
  const idleInTimerRecovery128 = (): TwoStationHarness => {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f));
    h.inject(h.a, { name: "T3_expiry" }); // idle poll → TimerRecovery, V(s)=V(a)
    h.dropWhen(undefined);
    return h;
  };
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") {
      // t02 (DL-DATA → I-frame pops) is exercised by the data-carrying mod-128
      // rigs (cases 14-18); here, with V(s)=V(a) and the window open, posting it
      // would pop and send a fresh I-frame (TimerRecovery is a send-capable
      // state, so the C# `canTransmitIFrame` gate permits it). We drive the flow
      // primitives that stay put instead.
      h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); // t05
      h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); // t06
      h.settle();
    }
    collect(h);
  }
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, sabmTo(h.a)); // t13_sabm_received_yes
    collect(h);
  }
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, sabmeTo(h.a)); // t14_sabme_received_yes
    collect(h);
  }

  // 18e. More mod-128 Connected receive branches.
  // FRMR received on an extended link → figc4.4 t16_frmr_received_yes
  // (version_2_2) → re-establish, routed to AwaitingV22Connection.
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, frmrTo(h.a)); collect(h); }
  // In-sequence I command with P=1 while Connected (enquiry-response branch).
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x5a, true)); collect(h); }
  // LM-SEIZE-confirm in Connected with NO ack pending (t23_lm_seize_confirm_no).
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.context.acknowledgePending = false; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  // An over-N1 I-frame (info field too long) → info_field_length error branch
  // (t26_i_received_yes_no_yes, version_2_2).
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    const big = new Uint8Array(h.a.context.n1 + 8);
    h.injectFrameBytes(
      h.a,
      iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, ns: 0, info: big, pollBit: false, extended: true }),
    );
    collect(h);
  }
  // An I-frame with N(R) out of the send window → t26_i_received_yes_yes_no_yes
  // (version_2_2 re-establish branch). N(R)=5 with V(a)=V(s)=0 is out of window.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.injectFrameBytes(h.a, iExt(h.a, 5, 0, 0x33, false));
    collect(h);
  }

  // 19. mod-128 RNR flow control: B goes busy mid-transfer (RNR), A holds, B
  // resumes (RR).
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.submit(h.a, 0x01);
    h.setBusy(h.b);
    h.submit(h.a, 0x02);
    h.submit(h.a, 0x03);
    h.clearBusy(h.b);
    h.flushAcks();
    collect(h);
  }

  // 20. mod-128 T3 idle keepalive: a quiescent connected station's T3 expiry
  // polls the peer (figc4.4 t13 → TimerRecovery), then the RR(F=1) response
  // settles it back to Connected.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.inject(h.a, { name: "T3_expiry" }); // t13_t3_expiry → poll → TimerRecovery
    h.advanceT1(); // let the poll/response cycle settle
    collect(h);
  }

  // 21. Connected receive-column odds reachable only by injection: a UI frame
  // (P=0 / P=1), and a SABME collision arriving on an established link.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.injectFrameBytes(h.a, uiTo(h.a, "u")); // t18_ui_received_no
    h.injectFrameBytes(h.a, uiTo(h.a, "v", true)); // t18_ui_received_yes
    h.injectFrameBytes(h.a, sabmeTo(h.a)); // t15_sabme_received (vs_eq_va)
    collect(h);
  }
  // 21b. SABM collision on a connected link with frames outstanding
  // (not vs_eq_va), so the not-equal branch of SABM/SABME-received fires.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    // Wedge one I-frame outstanding (drop B's acks) so V(s) != V(a).
    h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f));
    h.submit(h.a, 0x01);
    if (h.a.context.vs !== h.a.context.va) {
      h.dropWhen(undefined);
      h.injectFrameBytes(h.a, sabmTo(h.a)); // t14_sabm_received_no
    }
    collect(h);
  }

  // 21c. mod-8 Connected receive-column odds — the `not version_2_2` sibling
  // branches the extended rigs (21 / 18e) never reach. An over-N1 I-frame
  // (t26_i_received_yes_no_no, mod-8 info-too-long), and RR/RNR responses with
  // N(R) out of the send window (t21_rr_received_no_no / t22_rnr_received_no_no —
  // the not-in-window mod-8 branches). Mode-independent ids, exercised at mod-8.
  {
    const h = New({ k: 4 });
    h.connect();
    const big = new Uint8Array(h.a.context.n1 + 8);
    h.injectFrameBytes(
      h.a,
      iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, ns: 0, info: big, pollBit: false }),
    ); // t26_i_received_yes_no_no
    h.injectFrameBytes(
      h.a,
      rr({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false }),
    ); // t21_rr_received_no_no (N(R)=5 out of window)
    h.injectFrameBytes(
      h.a,
      rnr({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false }),
    ); // t22_rnr_received_no_no
    collect(h);
  }

  // 22. AwaitingV22Connection — push past the establishment column via its
  // catch-all input columns + a control-field error that all keep it parked:
  // t06 (other upper-layer), t18 (other lower-layer), t07 (control-field error).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") {
      h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); // t06
      h.settle();
      h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); // t18
      h.inject(h.a, { name: "control_field_error" }); // t07
    }
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MDL (management_data_link) machine — Ready / Negotiating. The MDL driver
  // runs its own SdlSessionDriver; the harness forwards its transition-fired
  // hook, so these register on the SAME ledger (Ready/Negotiating don't collide
  // with the data-link states). Drives every figc5.1/5.2 path the prose-bootstrap
  // encodes.
  // ──────────────────────────────────────────────────────────────────────────

  // 23. Happy-path XID negotiation between two v2.2 stations: the figc4.6 UA path
  // raises MDL-NEGOTIATE Request → XID command/response exchange → both confirm.
  // Ready t01 (negotiate) + Negotiating t01_yes (F=1 success).
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.connect();
    collect(h);
  }

  // 24. MDL error B — an unexpected XID response arriving in Ready (no command
  // outstanding). Ready t02_xid_response_received.
  {
    const h = New({ extended: true, srej: true, k: 8 });
    const info = encodeXid({ windowSizeRx: 4 });
    h.a.mdl.onXidReceived(
      xid({ destination: h.a.context.local, source: h.a.context.remote, info, isCommand: false, pollFinal: true }),
    );
    h.settle();
    collect(h);
  }

  // 25. MDL error D — an XID response without F=1 while Negotiating (stays
  // Negotiating, TM201 still running). Negotiating t01_xid_response_received_no.
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    if (h.a.mdlState === "Negotiating") {
      const info = encodeXid({ windowSizeRx: 4 });
      h.a.mdl.onXidReceived(
        xid({ destination: h.a.context.local, source: h.a.context.remote, info, isCommand: false, pollFinal: false }),
      );
      h.settle();
    }
    collect(h);
  }

  // 26. MDL v2.0 fallback — a pre-v2.2 peer FRMRs the XID command (figc5.2
  // t02_frmr_received → full §1436 v2.0 defaults, confirm, → Ready).
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    if (h.a.mdlState === "Negotiating") {
      h.a.mdl.onFrmrReceived(
        frmr({ destination: h.a.context.local, source: h.a.context.remote, info: new Uint8Array(0) }),
      );
      h.settle();
    }
    collect(h);
  }

  // 27. MDL TM201 retry + NM201 exhaustion (error C): drop every XID command so
  // no reply comes; TM201 retries (t03_tm201_expiry_no) then gives up at
  // RC==NM201 (t03_tm201_expiry_yes → MDL-ERROR C, → Ready).
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 2 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    for (let r = 0; r < 5 && h.a.mdlState === "Negotiating"; r++) h.advanceTm201();
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Segmentation over a mod-128 link (V4b shim through the wired path).
  // ──────────────────────────────────────────────────────────────────────────

  // 28. Multi-segment payload over mod-128 with a mid-series drop + selective
  // (SREJ) recovery — the V4 headline path, folded into the ledger so the
  // segment I-frame send/receive + SREJ recovery register.
  {
    const h = New({ extended: true, srej: true, k: 16, n2: 40, segmenter: true, n1: 64 });
    h.connect();
    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 5 + 2) & 0xff); // 5 segments
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f) && getNs(f) === 2) {
        dropped = true;
        return true;
      }
      return false;
    });
    h.submitLarge(h.a, payload);
    for (let r = 0; r < 40 && h.b.delivered.length === 0; r++) h.advanceT1();
    collect(h);
  }


  // ──────────────────────────────────────────────────────────────────────────
  // v2.2 arc V5b — reachable-coverage lift. The blocks below drive the
  // remaining reachable-but-undriven receive/primitive columns across every
  // data-link state, each in its own isolated rig so a transition's guard
  // combination is hit exactly. Logical transition ids are mode-independent;
  // the version_2_2 branches are selected by the rig's mod-8 / mod-128 mode.
  // Mirrors the C# TransitionCoverageTests lift (parity leg). The genuinely
  // unreachable residue is documented at the assertion below.
  // ──────────────────────────────────────────────────────────────────────────

  // Build a command frame (RR command) addressed to `t`, for the figc4.1 / figc4.8
  // catch-all columns whose event the production receive path reclassifies a
  // non-handled command into (all_other_commands / i_or_s_command_received). The
  // event carries the frame so the column's `F := P` reads its poll bit, exactly
  // as the listener's reclassification delivers it. Extended off — a U/S control
  // octet is mode-independent for these catch-alls.
  const cmdFrameTo = (t: Endpoint): Ax25Frame =>
    rr({ destination: t.context.local, source: t.context.remote, nr: 0, isCommand: true, pollFinal: true });
  const cmdFrameNoPollTo = (t: Endpoint): Ax25Frame =>
    rr({ destination: t.context.local, source: t.context.remote, nr: 0, isCommand: true, pollFinal: false });

  // Local TimerRecovery builders for this lift: drive A into recovery with N
  // unacked I-frames at mod-128 / mod-8 (drop A's I-frames, expire T1), or park
  // it IDLE in recovery via a T3-poll whose reply is dropped (V(s)=V(a)).
  const inTR128 = (outstanding: number, srejEnabled = false): TwoStationHarness => {
    const h = New({ extended: true, srej: srejEnabled, k: 8, n2: 40 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    for (let i = 0; i < outstanding; i++) h.submit(h.a, i);
    h.advanceT1();
    h.dropWhen(undefined);
    return h;
  };
  const inTR8 = (outstanding: number, srejEnabled = false): TwoStationHarness => {
    const h = New({ srej: srejEnabled, k: 4, n2: 40 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    for (let i = 0; i < outstanding; i++) h.submit(h.a, i);
    h.advanceT1();
    h.dropWhen(undefined);
    return h;
  };
  const idleTR128srej = (): TwoStationHarness => {
    const h = New({ extended: true, srej: true, k: 8 });
    h.connect();
    h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f));
    h.inject(h.a, { name: "T3_expiry" });
    h.dropWhen(undefined);
    return h;
  };


  // 29. Disconnected receive/primitive column (figc4.1) — the columns the §11
  // "no session up" rig (case 11) leaves undriven. DL-DISCONNECT/DL-UNIT-DATA
  // requests, the upper-layer + lower-layer catch-alls, the reclassified
  // all_other_commands catch-all (→ DM), a UI with P=1 (DM F=1), and — with the
  // station configured to refuse — the !able_to_establish SABM/SABME branches
  // (→ DM rather than accept).
  { const h = New(); h.a.driver.postEvent({ name: "DL_DISCONNECT_request" }); h.settle(); collect(h); } // t01
  { const h = New(); h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); h.settle(); collect(h); } // t02
  { const h = New(); h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); h.settle(); collect(h); } // t04
  { const h = New(); h.inject(h.a, { name: "all_other_commands", frame: cmdFrameTo(h.a) }); collect(h); } // t05
  { const h = New(); h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); collect(h); } // t06
  { const h = New(); h.injectFrameBytes(h.a, uiTo(h.a, "P", true)); collect(h); } // t11_ui_received_yes
  { const h = New(); h.a.context.acceptIncoming = false; h.injectFrameBytes(h.a, sabmTo(h.a)); collect(h); } // t13_sabm_received_no
  { const h = New({ extended: true }); h.a.context.acceptIncoming = false; h.injectFrameBytes(h.a, sabmeTo(h.a)); collect(h); } // t14_sabme_received_no

  // 30. AwaitingConnection receive/primitive column (figc4.3) — hold A there by
  // dropping B's UA, then walk the columns case 12 leaves undriven: redundant
  // DL-CONNECT (t07), DL-UNIT-DATA (t08), a not-layer-3-initiated DL-DATA
  // (t09_no), the upper-layer catch-all (t11), a lower-layer catch-all (t06), a
  // UA with F=0 (t04_no → DL-ERROR D), UI P=1/P=0 (t12), an incoming SABM (t16 →
  // UA, collision) and SABME (t17 → DM, routes to figc4.6), plus a redundant
  // DL-DISCONNECT (t01).
  const intoAwaitingConnection = (): TwoStationHarness => {
    const h = New();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    return h;
  };
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.a.driver.postEvent({ name: "DL_DISCONNECT_request" }); h.settle(); } collect(h); } // t01
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.injectFrameBytes(h.a, uaTo(h.a, false)); collect(h); } // t04_ua_received_no
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); collect(h); } // t06
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.a.driver.postEvent({ name: "DL_CONNECT_request" }); h.settle(); } collect(h); } // t07
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); h.settle(); } collect(h); } // t08
  // t09_no — a DL-DATA whose layer_3_initiated flag is clear (a connect that the
  // local layer-3 did NOT initiate); the figure's no-queue branch.
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.a.context.layer3Initiated = false; h.a.driver.postEvent({ name: "DL_DATA_request", data: Uint8Array.from([0x01]), pid: 0xf0 }); h.settle(); } collect(h); } // t09_dl_data_request_no
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); h.settle(); } collect(h); } // t11
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") { h.injectFrameBytes(h.a, uiTo(h.a, "q", true)); h.injectFrameBytes(h.a, uiTo(h.a, "r")); } collect(h); } // t12 yes/no
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.injectFrameBytes(h.a, sabmTo(h.a)); collect(h); } // t16_sabm_received
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.injectFrameBytes(h.a, sabmeTo(h.a)); collect(h); } // t17_sabme_received

  // 31. AwaitingRelease receive/primitive column (figc4.8) — case 13 walks a few;
  // these add the rest: a redundant DL-DISCONNECT (t01), DL-UNIT-DATA (t05), the
  // upper (t06) + lower (t04) catch-alls, a SABME (t11 → expedited DM), a DM with
  // F=0 (t13_no), UI P=1/P=0 (t14), an I-or-S command received with P=1/P=0 (t15
  // — the figc4.8 catch-all the listener reclassifies an unhandled command into),
  // and N2 exhaustion of the DISC retransmit (t02_t1_expiry_yes, → DL-ERROR G).
  const intoAwaitingRelease = (): TwoStationHarness => {
    const h = New();
    h.connect();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_DISCONNECT_request" });
    h.settle();
    return h;
  };
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") { h.a.driver.postEvent({ name: "DL_DISCONNECT_request" }); h.settle(); } collect(h); } // t01
  // t02_t1_expiry_yes — drop EVERY frame from B (not just its UA) so the resent
  // DISC also gets no DM reply; the retransmit then runs to RC == N2 and gives up.
  { const h = New({ n2: 3 }); h.connect(); h.dropWhen((f) => fromB(h, f)); h.a.driver.postEvent({ name: "DL_DISCONNECT_request" }); h.settle(); for (let r = 0; r < 8 && h.a.state === "AwaitingRelease"; r++) h.advanceT1(); collect(h); } // t02_t1_expiry_yes
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); collect(h); } // t04
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") { h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); h.settle(); } collect(h); } // t05
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") { h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); h.settle(); } collect(h); } // t06
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.injectFrameBytes(h.a, sabmeTo(h.a)); collect(h); } // t11_sabme_received
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.injectFrameBytes(h.a, dmTo(h.a, false)); collect(h); } // t13_dm_received_no
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") { h.injectFrameBytes(h.a, uiTo(h.a, "u", true)); h.injectFrameBytes(h.a, uiTo(h.a, "w")); } collect(h); } // t14 yes/no
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "i_or_s_command_received", frame: cmdFrameTo(h.a) }); collect(h); } // t15 yes
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "i_or_s_command_received", frame: cmdFrameNoPollTo(h.a) }); collect(h); } // t15 no

  // 32. Connected receive/primitive column (figc4.4) — the columns cases 3/7/21
  // leave undriven. DL-UNIT-DATA (t04); DL-FLOW-OFF when already busy (t05_no —
  // under the ax25Spec43 quirk a not-busy DL-FLOW-OFF enters busy, so the no-op
  // branch needs an already-busy station); DL-FLOW-ON not busy (t06_no) and busy
  // with T1 running (t06_yes_yes); a re-issued DL-CONNECT at mod-8 (t07_no) and
  // mod-128 (t07_yes); the upper-layer catch-all (t08); a control-field error at
  // mod-8 (t09_no); the never-permitted-info / frame-length error columns at
  // mod-8 (t10_no/t11_no) and mod-128 (t10_yes/t11_yes); a SABME collision with
  // frames outstanding (t15_no); a stray UA at mod-8 (t17_no); RNR/REJ/SREJ
  // responses with N(R) out of the send window at mod-8 and mod-128 (t22/t24/t25
  // _no_* re-establish branches); and the figc4.4 I-received receive sub-columns
  // reachable by a crafted I command (N(R) out of window, ack-pending delivery,
  // reject-exception, own-receiver-busy).
  { const h = New({ k: 4 }); h.connect(); h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); h.settle(); collect(h); } // t04
  { const h = New({ k: 4 }); h.connect(); h.setBusy(h.a); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); collect(h); } // t05_dl_flow_off_request_no
  { const h = New({ k: 4 }); h.connect(); h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); h.settle(); collect(h); } // t06_dl_flow_on_request_no
  // t06_yes_yes — own busy AND T1 running. Wedge one I-frame outstanding (drop
  // B's acks) so T1 stays armed, mark own busy, then clear the busy condition.
  { const h = New({ k: 4 }); h.connect(); h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f)); h.submit(h.a, 0x01); h.setBusy(h.a); h.dropWhen(undefined); h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); h.settle(); collect(h); } // t06_dl_flow_on_request_yes_yes
  { const h = New({ k: 4 }); h.connect(); h.a.driver.postEvent({ name: "DL_CONNECT_request" }); h.settle(); collect(h); } // t07_dl_connect_request_no (mod-8)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.driver.postEvent({ name: "DL_CONNECT_request" }); h.settle(); collect(h); } // t07_dl_connect_request_yes (mod-128)
  { const h = New({ k: 4 }); h.connect(); h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); h.settle(); collect(h); } // t08
  { const h = New({ k: 4 }); h.connect(); h.inject(h.a, { name: "control_field_error" }); collect(h); } // t09_control_field_error_no (mod-8)
  { const h = New({ k: 4 }); h.connect(); h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // t10_no (mod-8)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // t10_yes (mod-128)
  { const h = New({ k: 4 }); h.connect(); h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // t11_no (mod-8)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // t11_yes (mod-128)
  // t15_sabme_received_no — SABME collision while V(s) != V(a). Wedge one I-frame
  // outstanding (drop B's acks) so the not-equal branch fires.
  { const h = New({ extended: true, k: 8 }); h.connect(); h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f)); h.submit(h.a, 0x01); if (h.a.context.vs !== h.a.context.va) { h.dropWhen(undefined); h.injectFrameBytes(h.a, sabmeTo(h.a)); } collect(h); } // t15_sabme_received_no
  { const h = New({ k: 4 }); h.connect(); h.injectFrameBytes(h.a, uaTo(h.a, false)); collect(h); } // t17_ua_received_no (mod-8)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, rnrExt(h.a, 5, false, false)); collect(h); } // t22_rnr_received_no_yes
  { const h = New({ srej: true, k: 4 }); h.connect(); h.injectFrameBytes(h.a, srej({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false })); collect(h); } // t24_srej_received_no_no (mod-8)
  { const h = New({ extended: true, srej: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, srejExt(h.a, 5, false, false)); collect(h); } // t24_srej_received_no_yes
  { const h = New({ k: 4 }); h.connect(); h.injectFrameBytes(h.a, rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false })); collect(h); } // t25_rej_received_no_no (mod-8)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, rejExt(h.a, 5, false, false)); collect(h); } // t25_rej_received_no_yes
  // I-received sub-columns (figc4.4 t26).
  { const h = New({ k: 4 }); h.connect(); h.injectFrameBytes(h.a, iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, ns: 0, info: Uint8Array.from([0x40]), pollBit: false })); collect(h); } // t26_i_received_yes_yes_no_no (mod-8 N(R) out of window)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.context.acknowledgePending = true; h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x41, false)); collect(h); } // t26_i_received_yes_yes_yes_no_yes_no_yes (in-seq, ack pending)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.context.rejectException = true; h.injectFrameBytes(h.a, iExt(h.a, 0, 3, 0x42, true)); collect(h); } // t26_i_received_yes_yes_yes_no_no_yes_yes (out-of-seq, reject exc, P=1)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x43, true)); collect(h); } // t26_i_received_yes_yes_yes_yes_yes (own busy, P=1)
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x44, false)); collect(h); } // t26_i_received_yes_yes_yes_yes_no (own busy, P=0)

  // 33. TimerRecovery primitive/flow/error column (figc4.5) — the columns the
  // injection block (18b-d) leaves undriven, each on its own rig so an earlier
  // injection can't move A out of recovery first. DL-DISCONNECT (t01 → DISC,
  // AwaitingRelease); a DL-DATA that pushes + sends a fresh I-frame while
  // recovering (t02 + t03_no_no_yes); DL-FLOW-OFF already-busy (t05_no) and
  // DL-FLOW-ON not-busy (t06_no); the never-produced-error inputs whose action is
  // just Establish_Data_Link (t08/t09/t10 — re-establish, stay); and a SABM with
  // V(s) != V(a) (t13_sabm_received_no → resync to Connected).
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_DISCONNECT_request" }); h.settle(); collect(h); } // t01
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_DATA_request", data: Uint8Array.from([0x09]), pid: 0xf0 }); h.settle(); collect(h); } // t02 + t03_i_frame_pops_off_queue_no_no_yes
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); collect(h); } // t05_dl_flow_off_request_no
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); h.settle(); collect(h); } // t06_dl_flow_on_request_no
  { const h = inTR128(1); h.inject(h.a, { name: "control_field_error" }); collect(h); } // t08
  { const h = inTR128(1); h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // t09
  { const h = inTR128(1); h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // t10
  { const h = inTR128(1); h.injectFrameBytes(h.a, sabmTo(h.a)); collect(h); } // t13_sabm_received_no

  // 34. TimerRecovery RR/RNR receive sub-columns (figc4.5 t18/t19) — out-of-window
  // and partial-ack N(R) variants, command vs response, at mod-128 and mod-8.
  { const h = inTR128(2); h.injectFrameBytes(h.a, rrExt(h.a, 5, false, false)); collect(h); } // t18_rr_received_no_no_no
  { const h = inTR128(2); h.injectFrameBytes(h.a, rrExt(h.a, 5, false, true)); collect(h); } // t18_rr_received_yes_no_yes (mod-128, N(R) oow, F=1)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rrExt(h.a, 5, true, true)); collect(h); } // t18_rr_received_no_yes_no_yes (mod-128, command P=1, N(R) oow)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rr({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: false, pollFinal: true })); collect(h); } // t18_rr_received_yes_no_no (mod-8)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rr({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: true, pollFinal: true })); collect(h); } // t18_rr_received_no_yes_no_no (mod-8)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 1, false, false)); collect(h); } // t19_rnr_received_no_no_yes (in-window response)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 5, false, false)); collect(h); } // t19_rnr_received_no_no_no (out-of-window response)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 5, false, true)); collect(h); } // t19_rnr_received_yes_no_yes (mod-128, F=1, N(R) oow)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 1, false, true)); collect(h); } // t19_rnr_received_yes_yes_no (F=1, N(R) in window, != V(s))
  { const h = inTR128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 5, true, true)); collect(h); } // t19_rnr_received_no_yes_no_yes (mod-128, command P=1, N(R) oow)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rnr({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: false, pollFinal: true })); collect(h); } // t19_rnr_received_yes_no_no (mod-8)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rnr({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: true, pollFinal: true })); collect(h); } // t19_rnr_received_no_yes_no_no (mod-8)

  // 35. TimerRecovery I-received sub-columns (figc4.5 t22) + N2 exhaustion with
  // an empty window (t21). An I command with N(R) out of window (mod-8); an
  // in-sequence I, P=0, with no ack pending; own-receiver-busy I with P=1/P=0; an
  // out-of-sequence I with reject-exception set (P=1/P=0); the SREJ go-back
  // first-gap and subsequent-gap branches; and an over-N1 I command. The t21
  // empty-window N2 give-up runs an idle T3-poll into recovery (V(s)=V(a)) then
  // starves the retransmit to RC == N2 with the peer not busy.
  { const h = New({ extended: true, k: 8, n2: 3 }); h.connect(); h.dropWhen((f) => fromB(h, f)); h.inject(h.a, { name: "T3_expiry" }); for (let r = 0; r < 8 && h.a.state === "TimerRecovery"; r++) h.advanceT1(); collect(h); } // t21_t1_expiry_yes_yes_no
  { const h = inTR8(1); h.injectFrameBytes(h.a, iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, ns: 0, info: Uint8Array.from([0x23]), pollBit: false })); collect(h); } // t22_i_received_yes_yes_no (mod-8 N(R) oow)
  { const h = inTR128(1); h.a.context.acknowledgePending = false; h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x24, false)); collect(h); } // t22_i_received_yes_yes_yes_no_yes_no_no
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x25, true)); collect(h); } // t22_i_received_yes_yes_yes_yes_yes (own busy, P=1)
  { const h = inTR128(1); h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); h.settle(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x26, false)); collect(h); } // t22_i_received_yes_yes_yes_yes_no (own busy, P=0)
  { const h = inTR128(1); h.a.context.rejectException = true; h.injectFrameBytes(h.a, iExt(h.a, 0, 3, 0x27, true)); collect(h); } // t22_i_received_yes_yes_yes_no_no_yes_yes (reject exc, P=1)
  { const h = inTR128(1); h.a.context.rejectException = true; h.injectFrameBytes(h.a, iExt(h.a, 0, 3, 0x28, false)); collect(h); } // t22_i_received_yes_yes_yes_no_no_yes_no (reject exc, P=0)
  { const h = inTR128(1, true); h.injectFrameBytes(h.a, iExt(h.a, 0, 1, 0x29, false)); collect(h); } // t22_i_received_yes_yes_yes_no_no_no_yes_no_no (SREJ first gap)
  { const h = inTR128(1, true); h.a.context.srejExceptionCount = 1; h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0x2a, false)); collect(h); } // t22_i_received_yes_yes_yes_no_no_no_yes_yes (SREJ subsequent gap)
  { const h = inTR128(1); const big = new Uint8Array(h.a.context.n1 + 8); h.injectFrameBytes(h.a, iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, ns: 0, info: big, pollBit: false, extended: true })); collect(h); } // t22_i_received_yes_no (over-N1)

  // 36. TimerRecovery REJ/SREJ receive sub-columns (figc4.5 t23/t24) — partial,
  // complete, out-of-window, command vs response, at mod-128 and mod-8, plus the
  // empty-window SREJ branches reached via an idle T3-poll recovery (V(s)=V(a)).
  { const h = inTR128(2); h.injectFrameBytes(h.a, rejExt(h.a, 1, false, false)); collect(h); } // t23_rej_received_no_no_yes_no (response F=0, partial)
  { const h = inTR128(1); h.injectFrameBytes(h.a, rejExt(h.a, 1, false, true)); collect(h); } // t23_rej_received_yes_yes_yes (response F=1, complete → Connected)
  { const h = inTR128(2); h.injectFrameBytes(h.a, rejExt(h.a, 5, true, true)); collect(h); } // t23_rej_received_no_yes_no_yes (mod-128, command P=1, N(R) oow)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: false, pollFinal: true })); collect(h); } // t23_rej_received_yes_no_no (mod-8)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: true, pollFinal: true })); collect(h); } // t23_rej_received_no_yes_no_no (mod-8)
  { const h = inTR128(1, true); h.injectFrameBytes(h.a, srejExt(h.a, 1, true, true)); collect(h); } // t24_srej_received_no_yes_yes_yes (command P=1, complete)
  { const h = inTR128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 1, true, false)); collect(h); } // t24_srej_received_no_yes_no_no (command P=0, resend)
  { const h = inTR128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 1, false, true)); collect(h); } // t24_srej_received_yes_yes_yes_no (response F=1, partial)
  { const h = idleTR128srej(); if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, srejExt(h.a, h.a.context.vs, true, false)); collect(h); } // t24_srej_received_no_yes_no_yes (command P=0, V(s)=V(a))
  { const h = idleTR128srej(); if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, srejExt(h.a, h.a.context.vs, false, false)); collect(h); } // t24_srej_received_yes_yes_no_yes (response F=0, V(s)=V(a) → Connected)
  { const h = inTR8(2, true); h.injectFrameBytes(h.a, srej({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: false, pollFinal: false })); collect(h); } // t24_srej_received_yes_no_no (mod-8)
  { const h = inTR8(2, true); h.injectFrameBytes(h.a, srej({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: true, pollFinal: false })); collect(h); } // t24_srej_received_no_no_no (mod-8)


  // 37. Error-input receive columns (control_field_error / info_not_permitted /
  // u_or_s_frame_length_error) across the establishment + release states. These
  // are the figc4.x receive-path malformation events: the SDL handles each with a
  // DL-ERROR Indication and stays put. They are reached by injecting the
  // classified error event (the same mechanism the TimerRecovery/Connected error
  // rigs above use) — the figc4.x receive path raises these on a malformed frame.
  // The data-link figc4.6 t04_no buffer-while-v2.2-pending closes that column too.
  { const h = New(); h.inject(h.a, { name: "control_field_error" }); collect(h); } // Disconnected t07
  { const h = New(); h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // Disconnected t08
  { const h = New(); h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // Disconnected t09
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.inject(h.a, { name: "control_field_error" }); collect(h); } // AwaitingConnection t13
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // AwaitingConnection t14
  { const h = intoAwaitingConnection(); if (h.a.state === "AwaitingConnection") h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // AwaitingConnection t15
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "control_field_error" }); collect(h); } // AwaitingRelease t07
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // AwaitingRelease t08
  { const h = intoAwaitingRelease(); if (h.a.state === "AwaitingRelease") h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // AwaitingRelease t09

  // AwaitingV22Connection (figc4.6) — a not-layer-3-initiated DL-DATA buffers
  // (t04_no), and the two error-input columns raise their DL-ERROR Indication.
  const intoAwaitingV22 = (): TwoStationHarness => {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    return h;
  };
  { const h = intoAwaitingV22(); if (h.a.state === "AwaitingV22Connection") { h.a.context.layer3Initiated = false; h.a.driver.postEvent({ name: "DL_DATA_request", data: Uint8Array.from([0x01]), pid: 0xf0 }); h.settle(); } collect(h); } // t04_dl_data_request_no
  { const h = intoAwaitingV22(); if (h.a.state === "AwaitingV22Connection") h.inject(h.a, { name: "info_not_permitted_in_frame" }); collect(h); } // t08
  { const h = intoAwaitingV22(); if (h.a.state === "AwaitingV22Connection") h.inject(h.a, { name: "u_or_s_frame_length_error" }); collect(h); } // t09

  // 38. TimerRecovery REJ/SREJ out-of-window remainders (figc4.5) — a REJ response
  // F=1 with N(R) out of window at mod-128 (t23 yes_no_yes) and the mod-8 REJ
  // response F=0 out-of-window go-back (t23 no_no_no_no), plus an SREJ command
  // with N(R) out of window at mod-128 (t24 no_no_yes).
  { const h = inTR128(2); h.injectFrameBytes(h.a, rejExt(h.a, 5, false, true)); collect(h); } // t23_rej_received_yes_no_yes (mod-128)
  { const h = inTR8(2); h.injectFrameBytes(h.a, rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 7, isCommand: false, pollFinal: false })); collect(h); } // t23_rej_received_no_no_no_no (mod-8)
  { const h = inTR128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 5, true, false)); collect(h); } // t24_srej_received_no_no_yes (mod-128)

  // The OR'd membership predicate over every rig.
  return (from, id) => rigs.some((h) => h.firedTransition(from, id));
}

describe("v2.2 arc V5b — behavioural transition-coverage ledger", () => {
  it("the scenario battery meets the curated floor and reports per-state coverage", () => {
    const fired = runBatteryAndCollectFired();

    // ── Report (per-state hit/total + the misses) ──────────────────
    let total = 0;
    let hit = 0;
    const lines: string[] = [];
    for (const [state, page] of TABLES) {
      const ids = page.transitions.map((t) => t.id);
      const covered = ids.filter((id) => fired(state, id));
      total += ids.length;
      hit += covered.length;
      lines.push(`${state.padEnd(22)} ${String(covered.length).padStart(3)}/${String(ids.length).padEnd(3)} behavioural`);
      const misses = ids.filter((id) => !fired(state, id));
      if (misses.length > 0) lines.push(`    miss: ${misses.join(", ")}`);
    }
    lines.push(`\nTOTAL ${hit}/${total} transitions behaviourally exercised by the battery`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // ── Assert: each reachable state is behaviourally exercised (a curated,
    // robust must-hit — confirmed-fired ids the battery is built to drive). As of
    // v2.2 arc V5b the battery drives every REACHABLE transition across all six
    // data-link states plus the MDL machine (238/250). The 12 remaining misses
    // are GENUINELY unreachable through the real runtime, in three classes:
    //
    //   1. I_frame_pops_off_queue variants the canTransmitIFrame gate suppresses
    //      (packet.net#263). The synthetic "I-frame pops off the queue" event is
    //      only generated from Connected / TimerRecovery with the peer not busy
    //      and the window not full; a queued frame in any other situation stays
    //      buffered and the pop event is never synthesised. So:
    //        AwaitingConnection    t10_i_frame_pops_off_queue_yes / _no
    //        AwaitingV22Connection t05_i_frame_pops_off_queue_yes / _no
    //        Connected             t03_i_frame_pops_off_queue_yes (peer busy)
    //        Connected             t03_i_frame_pops_off_queue_no_yes (window full)
    //        TimerRecovery         t03_i_frame_pops_off_queue_yes (peer busy)
    //        TimerRecovery         t03_i_frame_pops_off_queue_no_yes (window full)
    //        TimerRecovery         t03_i_frame_pops_off_queue_no_no_no (T1 idle —
    //                              but T1 is always running in recovery)
    //   2. The I-response columns (Connected t26_i_received_no /
    //      TimerRecovery t22_i_received_no, both guarded `!command`). I-frames are
    //      command-only on the wire (§4.2.1); the codec cannot produce an
    //      I-response, so an I_received event is always a command.
    //   3. TimerRecovery t06_dl_flow_on_request_yes_no (own busy & !T1_running) —
    //      T1 is by definition always running while in the recovery state, so the
    //      !T1_running branch can't be reached from TimerRecovery.
    //
    // The MDL (management_data_link) machine is on the ledger too (Ready /
    // Negotiating, both fully exercised). Mirrors the C# must-hit set + the C#
    // lift (parity leg). ──
    const mustHit: ReadonlyArray<readonly [string, string]> = [
      ["Disconnected", "t03_dl_connect_request"], // A initiates a connect
      ["Disconnected", "t13_sabm_received_yes"], // B accepts an incoming SABM
      ["AwaitingConnection", "t04_ua_received_yes_yes"], // connect completes
      ["AwaitingV22Connection", "t12_ua_received_yes_yes"], // mod-128 connect completes (figc4.6)
      ["AwaitingV22Connection", "t13_t1_expiry_no"], // lost SABME retried as SABME
      ["AwaitingV22Connection", "t14_frmr_received"], // §975 v2.0 fallback
      ["AwaitingV22Connection", "t11_dm_received_yes"], // §975 DM teardown
      ["AwaitingV22Connection", "t07_control_field_error"], // V5a: malformed frame while v2.2-pending
      ["AwaitingV22Connection", "t06_all_other_primitives__from_upper_layer"], // V5a: catch-all upper
      ["AwaitingV22Connection", "t18_all_other_primitives__from_lower_layer"], // V5a: catch-all lower
      ["Connected", "t02_dl_data_request"], // upper layer sends data
      ["Connected", "t21_rr_received_yes"], // an RR acks
      ["Connected", "t13_t3_expiry"], // V5a: idle keepalive poll
      ["Connected", "t16_frmr_received_yes"], // V5a: extended-link FRMR → re-establish (v2.2 branch)
      ["Connected", "t18_ui_received_yes"], // V5a: connectionless UI on an established link
      ["Connected", "t26_i_received_yes_no_yes"], // V5a: over-N1 I-frame (info too long, v2.2 branch)
      ["AwaitingRelease", "t03_ua_received_yes"], // disconnect completes
      ["TimerRecovery", "t15_frmr_received"], // FRMR during recovery
      ["TimerRecovery", "t18_rr_received_yes_yes_yes"], // V5a: poll/final RR completes mod-128 recovery
      ["TimerRecovery", "t24_srej_received_yes_yes_yes_yes"], // V5a: SREJ selective recovery (7-bit)
      ["TimerRecovery", "t12_dm_received"], // V5a: DM teardown while recovering
      ["TimerRecovery", "t20_lm_seize_confirm_yes"], // V5a: LM-SEIZE-confirm with ack pending
      ["TimerRecovery", "t14_sabme_received_no"], // V5a: SABME collision while recovering
      // V5b reachable-coverage lift — receive/primitive columns now driven.
      ["Disconnected", "t01_dl_disconnect_request"], // V5b: redundant disconnect (no-op confirm)
      ["Disconnected", "t05_all_other_commands"], // V5b: reclassified command catch-all → DM
      ["Disconnected", "t11_ui_received_yes"], // V5b: UI P=1 → DM F=1
      ["Disconnected", "t13_sabm_received_no"], // V5b: SABM while unable to establish → DM
      ["Disconnected", "t07_control_field_error"], // V5b: malformed-frame error input → DL-ERROR L
      ["AwaitingConnection", "t07_dl_connect_request"], // V5b: redundant connect (discard queue)
      ["AwaitingConnection", "t04_ua_received_no"], // V5b: UA F=0 → DL-ERROR D
      ["AwaitingConnection", "t16_sabm_received"], // V5b: SABM collision → UA
      ["AwaitingConnection", "t17_sabme_received"], // V5b: SABME → DM (routes to figc4.6)
      ["AwaitingV22Connection", "t04_dl_data_request_no"], // V5b: buffer-while-v2.2-pending (not-l3-initiated)
      ["AwaitingV22Connection", "t08_info_not_permitted_in_frame"], // V5b: error input → DL-ERROR M
      ["Connected", "t07_dl_connect_request_no"], // V5b: re-issued connect at mod-8 → re-establish
      ["Connected", "t15_sabme_received_no"], // V5b: SABME collision with frames outstanding
      ["Connected", "t25_rej_received_no_yes"], // V5b: REJ N(R) out of window → re-establish (v2.2)
      ["Connected", "t26_i_received_yes_yes_no_no"], // V5b: I command N(R) out of window (mod-8)
      ["AwaitingRelease", "t02_t1_expiry_yes"], // V5b: DISC retransmit N2 exhaustion → DL-ERROR G
      ["AwaitingRelease", "t11_sabme_received"], // V5b: SABME during release → expedited DM
      ["AwaitingRelease", "t15_i_or_s_command_received_yes"], // V5b: I/S command during release → DM F=1
      ["TimerRecovery", "t01_dl_disconnect_request"], // V5b: disconnect while recovering → AwaitingRelease
      ["TimerRecovery", "t02_dl_data_request"], // V5b: DL-DATA while recovering (queue + send)
      ["TimerRecovery", "t13_sabm_received_no"], // V5b: SABM with V(s)!=V(a) → resync
      ["TimerRecovery", "t19_rnr_received_yes_yes_no"], // V5b: RNR F=1, partial-ack recovery
      ["TimerRecovery", "t22_i_received_yes_yes_yes_yes_yes"], // V5b: own-busy I delivery while recovering
      ["TimerRecovery", "t23_rej_received_yes_yes_yes"], // V5b: REJ F=1 completes recovery → Connected
      ["TimerRecovery", "t21_t1_expiry_yes_yes_no"], // V5b: empty-window N2 give-up (no peer busy)
      // MDL (management_data_link) — XID negotiation FSM, on the ledger via V5a.
      ["Ready", "t01_mdl_negotiate_request"], // XID command sent on a v2.2 connect
      ["Negotiating", "t01_xid_response_received_yes"], // negotiation completes (F=1)
      ["Negotiating", "t02_frmr_received"], // pre-v2.2 peer FRMRs → v2.0 fallback
      ["Negotiating", "t03_tm201_expiry_yes"], // NM201 retry limit → MDL-ERROR C
    ];
    const missingMustHit = mustHit.filter(([state, id]) => !fired(state, id));
    expect(
      missingMustHit,
      `the battery should behaviourally exercise every curated must-hit transition; missing: ${missingMustHit
        .map(([s, i]) => `${s}/${i}`)
        .join(", ")}`,
    ).toEqual([]);

    // ── Assert: a floor on total behavioural coverage (regression guard) ──
    // Raised 122 → 238/250 (v2.2 arc V5b: the reachable receive/primitive columns
    // across every data-link state are now driven on isolated rigs — Disconnected
    // 6→17, AwaitingConnection 9→23, AwaitingV22Connection 20→23, Connected
    // 39→63, AwaitingRelease 6→20, TimerRecovery 38→85; Ready/Negotiating already
    // full). The remaining 12 misses are GENUINELY unreachable through the runtime
    // (see the report log + the curated list below). If this drops, a scenario
    // regressed or a path stopped being reached.
    expect(
      hit,
      `the scenario battery should behaviourally exercise a substantial share of the ${total} transitions; ` +
        "if this drops, a scenario regressed or a path stopped being reached",
    ).toBeGreaterThanOrEqual(238);
  });
});
