/**
 * mod-128 (extended / SABME) **fallback-path** interop: dial extended against a
 * peer that does NOT implement mod-128, assert graceful degradation to mod-8, and
 * assert the fallback link still carries data. TS leg of packet.net#239 (issue
 * ax25-ts#69), mirroring the two C# `*ViaNetsimExtendedMode` classes one-to-one:
 *
 *   • **LinBPQ — FRMR fallback.** LinBPQ does not implement mod-128 at L2: its
 *     `L2Code.c` answers an inbound SABME with an FRMR ("invalid control field").
 *     Our `connect(remote, true)` (extended) emits a SABME, BPQ FRMRs it, and the
 *     figc4.6 FRMR-fallback
 *     ({@link Ax25SessionQuirks.ax25Spec45FrmrFallbackReestablishesV20}, default on)
 *     forces v2.0 and re-establishes with a SABM — a **mod-8** connection. Mirrors
 *     C# `LinbpqViaNetsimExtendedMode`.
 *
 *   • **XRouter — DM fallback.** XRouter rejects our polled SABME with a DM(F=1)
 *     on the incoming path. The figc4.6 DM-fallback
 *     ({@link Ax25SessionQuirks.ax25Spec48DmRejectionDegradesToV20}, default on)
 *     likewise forces v2.0 and re-establishes with a SABM. Mirrors C#
 *     `XrouterViaNetsimExtendedMode`.
 *
 * **Why net-sim, not AXUDP.** The C# extended-mode matrix proves *both* fallbacks
 * over net-sim — there is no `*ViaAxudpExtendedMode` on the C# side. LinBPQ's
 * BPQAXIP/UDP listener and XRouter's AXUDP peer-pair both work for the SABME→
 * FRMR/DM→SABM handshake, but BPQ's `AUTOADDQUIET` reply-route cache is learned
 * per (callsign, source UDP port) and persists in the long-running daemon, so an
 * extended fallback dialled over AXUDP is sensitive to stale-cache contention
 * across re-runs (the documented `linbpq-via-axudp` pitfall). net-sim's broadcast
 * AFSK channel has no such per-peer learned-route state, making the fallback
 * handshake deterministic — which is why the C# author put these rows on net-sim,
 * and why we mirror that tier exactly here. The refusal frames (FRMR / DM) are
 * U-frames — one control octet in both moduli — so `onFrameTraced`'s modulo-8
 * routing parse reads them correctly (no extended re-decode needed; cf. the
 * separate-tap dance the direwolf success-path test needs for mod-128 I-frames).
 *
 * Each case asserts: the extended dial completes Connected, the link degraded to
 * mod-8 (`context.isExtended` flipped to false — the fallback genuinely fired,
 * not a mod-128 link), the refusal frame (FRMR / DM) was seen on the wire, the
 * fallback link round-trips a node-prompt command, then a clean DISC/UA.
 *
 * The describe block self-skips if `127.0.0.1:8100` (net-sim's KISS-TCP) isn't
 * reachable. Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *   npm run test:integration
 */
import { Socket, createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { type Ax25Frame, classify } from "../../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../../src/listener.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";

const HOST = "127.0.0.1";
const NETSIM_KISS_PORT = 8100; // external KISS attach (net-sim node a)

// LinBPQ's NODECALL — the FRMR-fallback connect target. Distinct SSID on our
// side from the C# LinbpqViaNetsimExtendedMode's PNT128 so the two suites don't
// collide on the shared net-sim broadcast bus.
const BPQ_CALL = "PN0TST";
const BPQ_OUR_CALL = "PNTSF8-1";

// XRouter's NODECALL — the DM-fallback connect target. Distinct SSID from the C#
// XrouterViaNetsimExtendedMode's PNX128.
const XROUTER_CALL = "PN0XRT";
const XROUTER_OUR_CALL = "PNXTS-1";

// Tier-3 (software-AFSK, load-sensitive) budgets, matched to the C# siblings'
// 40 s connect / 30 s data / 30 s disconnect. waitUntil / the awaiter return as
// soon as the predicate holds, so the headroom is free on a quiet host.
const CONNECT_BUDGET_MS = 40_000;
const DATA_BUDGET_MS = 30_000;
const DISCONNECT_BUDGET_MS = 30_000;

async function netsimReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // best-effort
      }
      resolve(ok);
    };
    try {
      socket = createConnection({ host: HOST, port: NETSIM_KISS_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 200);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await netsimReachable();

describe.skipIf(!stackReachable)(
  "ax25-ts mod-128 extended dial degrades to mod-8 against a non-v2.2 peer over net-sim",
  () => {
    let listener: Ax25Listener | null = null;
    let transport: TcpKissTransport | null = null;

    const buildListener = (myCall: string) => {
      transport = new TcpKissTransport(HOST, NETSIM_KISS_PORT, { kissPort: 0 });
      listener = new Ax25Listener(transport, { myCall });
    };

    afterEach(async () => {
      try {
        await listener?.dispose();
      } catch {
        // best-effort
      }
      listener = null;
      transport = null;
    });

    // ─── LinBPQ — FRMR fallback (mirrors C# LinbpqViaNetsimExtendedMode) ────
    it(
      "ExtendedConnect_FallsBackToMod8_OnLinbpqFrmr_CarriesData_ThenDisconnects",
      async () => {
        buildListener(BPQ_OUR_CALL);
        const rxFrames: Ax25Frame[] = [];
        listener!.onFrameTraced((e) => {
          if (e.direction === "rx") rxFrames.push(e.frame);
        });

        await listener!.start();
        // Settle so net-sim's per-port TX queue is ready before the SABME.
        await new Promise((r) => setTimeout(r, 500));

        // Dial EXTENDED: emits SABME → BPQ FRMRs it → figc4.6 FRMR-fallback
        // (Spec45) forces v2.0 and re-establishes with SABM → mod-8 Connected.
        // connect() resolves on the DL-CONNECT-confirm the fallback produces.
        const session: Ax25ListenerSession = await listener!.connect(
          BPQ_CALL,
          /* extended */ true,
        );

        expect(session.state).toBe("Connected");
        // The FRMR fallback forces version 2.0 — the completed link is mod-8,
        // not mod-128. isExtended flipping to false IS the proof the fallback
        // fired (it started true on the extended dial).
        expect(session.context.isExtended).toBe(false);

        // Wire evidence: BPQ rejected our SABME with an FRMR (its documented
        // mod-128 response — "invalid control field").
        expect(rxFrames.some((f) => classify(f) === "FRMR")).toBe(true);

        // ─── The fallback link carries data ─────────────────────────────
        const data = new ChunkAwaiter();
        session.onData((chunk) => data.push(chunk));

        // BPQ emits its node-prompt banner as I-frame(s) right after the link
        // is up; drain it so it can't masquerade as the command response.
        const banner = await data.waitForNext(DATA_BUDGET_MS);
        expect(banner).not.toBeNull();
        expect(banner!.length).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 1000));
        data.drain();

        // `P\r` = Ports command — short, deterministically non-empty, no side
        // effects. A round-trip over the mod-8 fallback link.
        await session.write(new TextEncoder().encode("P\r"));
        const response = await data.waitForNext(DATA_BUDGET_MS);
        expect(response).not.toBeNull();
        expect(response!.length).toBeGreaterThan(0);

        // ─── Clean disconnect ───────────────────────────────────────────
        await session.disconnect();
        await waitUntil(() => session.state === "Disconnected", DISCONNECT_BUDGET_MS);
        expect(session.state).toBe("Disconnected");
      },
      CONNECT_BUDGET_MS + DATA_BUDGET_MS * 2 + DISCONNECT_BUDGET_MS + 15_000,
    );

    // ─── XRouter — DM fallback (mirrors C# XrouterViaNetsimExtendedMode) ────
    it(
      "ExtendedConnect_FallsBackToMod8_OnXrouterDm_CarriesData_ThenDisconnects",
      async () => {
        buildListener(XROUTER_OUR_CALL);
        const rxFrames: Ax25Frame[] = [];
        listener!.onFrameTraced((e) => {
          if (e.direction === "rx") rxFrames.push(e.frame);
        });

        await listener!.start();
        await new Promise((r) => setTimeout(r, 500));

        // Dial EXTENDED: emits SABME → XRouter DMs it → figc4.6 DM-fallback
        // (Spec48) forces v2.0 and re-establishes with SABM → mod-8 Connected.
        const session: Ax25ListenerSession = await listener!.connect(
          XROUTER_CALL,
          /* extended */ true,
        );

        expect(session.state).toBe("Connected");
        // DM fallback forces version 2.0 — the completed link is mod-8.
        expect(session.context.isExtended).toBe(false);

        // Wire evidence: XRouter rejected our SABME with a DM (its
        // mod-128-incapable response on the incoming path).
        expect(rxFrames.some((f) => classify(f) === "DM")).toBe(true);

        // ─── The fallback link carries data ─────────────────────────────
        // XRouter's NODECALL connect does not emit a CTEXT banner (alias-only),
        // so we don't wait for one — just settle, then round-trip a command.
        await new Promise((r) => setTimeout(r, 1500));

        const data = new ChunkAwaiter();
        session.onData((chunk) => data.push(chunk));

        // `?\r` = help-summary command — deterministically non-empty.
        await session.write(new TextEncoder().encode("?\r"));
        const response = await data.waitForNext(DATA_BUDGET_MS);
        expect(response).not.toBeNull();
        expect(response!.length).toBeGreaterThan(0);

        // ─── Clean disconnect ───────────────────────────────────────────
        await session.disconnect();
        await waitUntil(() => session.state === "Disconnected", DISCONNECT_BUDGET_MS);
        expect(session.state).toBe("Disconnected");
      },
      CONNECT_BUDGET_MS + DATA_BUDGET_MS + DISCONNECT_BUDGET_MS + 15_000,
    );
  },
);

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${budgetMs}ms`);
}

/**
 * Bounded queue + a one-shot "wait for next" promise (returns null on timeout
 * rather than rejecting, so the assertion message is the test's, not a raw
 * throw). Same shape as the linbpq-via-netsim ChunkAwaiter.
 */
class ChunkAwaiter {
  private readonly queue: Uint8Array[] = [];
  private resolver: ((chunk: Uint8Array | null) => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r(chunk);
      return;
    }
    this.queue.push(chunk);
  }

  drain(): void {
    this.queue.length = 0;
  }

  async waitForNext(budgetMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = null;
        resolve(null);
      }, budgetMs);
      this.resolver = (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      };
    });
  }
}
