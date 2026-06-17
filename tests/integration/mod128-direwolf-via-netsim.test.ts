/**
 * mod-128 (extended / SABME) **success-path** interop against the real Dire Wolf
 * (WB2OSZ 1.8.1) connected-mode engine over the AFSK1200 link the `pn-direwolf`
 * container exposes. TS leg of packet.net#239 (issue ax25-ts#69), mirroring the
 * C# `DirewolfMod128Interop`
 * (`tests/Packet.Interop.Tests/Direwolf/DirewolfMod128Interop.cs` in
 * packet-net/packet.net).
 *
 * **Why this is the only genuine mod-128 row.** Dire Wolf is the *only*
 * mod-128-capable peer in the docker matrix. As the responder its `sabm_e_frame`
 * handler runs `set_version_2_2` (→ `modulo = 128`) on an inbound SABME and
 * answers UA — there is no config knob and no FRMR/DM fallback (LinBPQ FRMRs the
 * SABME, XRouter DMs it — those degrade-to-mod-8 rows live in
 * {@link ./mod128-fallback-via-netsim.test.ts}). So a real mod-128 link can only be
 * established here. We dial extended (`connect(remote, true)`), and assert (a) we
 * reach Connected, (b) the link is genuinely extended (`context.isExtended` stays
 * true — no fallback fired), (c) a two-octet (extended) control field is seen on
 * the wire — the on-the-wire proof of mod-128 sequencing, not mod-8 — and (d) a
 * payload round-trips BOTH directions, then a clean DISC/UA disconnect.
 *
 * **The 2-octet wire proof — why a transport tap, not `onFrameTraced`.** The
 * listener's inbound pump (and the C# listener's) parses every frame at modulo-8
 * for *routing* — the session, and thus the modulo, isn't known until the address
 * is read — and only re-decodes an extended I/S frame at modulo-128 once the
 * session is matched (`reparseAtSessionModulo`). `onFrameTraced` fires on that
 * modulo-8 routing parse, so it can't show a mod-128 I-frame's 2-octet control
 * field (it mis-reads it as control + first info byte). The C# `DirewolfMod128Interop`
 * proves the 2-octet field from a *separate* rig pump that re-parses inbound bytes
 * at `Context.IsExtended`; we mirror that here with a thin {@link ExtendedRxTap}
 * transport decorator that re-decodes the raw inbound bytes at modulo-128 — the
 * faithful equivalent of the C# rig's `Observed` log.
 *
 * **Topology — why net-sim-style, not AXUDP.** Dire Wolf's connected-mode engine
 * (`ax25_link.c`) is reachable only over the AGW protocol with a client app that
 * has registered the called callsign on a real (audio) radio channel — raw KISS
 * bypasses it. The `pn-direwolf` container runs two Dire Wolf instances sharing
 * one PulseAudio null sink as the simulated AFSK1200 RF channel: `direwolf-gw` is
 * a transparent KISS modem (we dial its KISS-TCP, published on host
 * {@link DIREWOLF_KISS_PORT}) and `direwolf-resp` runs the connected-mode engine,
 * driven by the in-container AGW echo helper that registers the callsigns below
 * and **echoes connected data straight back** (our reverse-leg I-frame). Dire Wolf
 * is its own self-contained RF, so it is the AFSK-only peer the issue's "net-sim
 * tier for AFSK-only peers" carve-out names — there is no AXUDP tier to prefer.
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *   npm run test:integration
 *
 * The describe block self-skips if `127.0.0.1:8106` (direwolf-gw's KISS-TCP)
 * isn't reachable, so it is safe to leave wired into CI / local dev.
 */
import { Socket, createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  type Ax25Frame,
  LENIENT_PARSE,
  classify,
  decodeFrame,
  isExtendedControl,
} from "../../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../../src/listener.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";
import type { Ax25Transport } from "../../src/transport.js";

const HOST = "127.0.0.1";
// direwolf-gw's KISS-TCP, published on the host. Distinct from net-sim's
// 8100/8101 — Dire Wolf is its own self-contained RF (see file header).
const DIREWOLF_KISS_PORT = 8106;

// Our station — distinct SSID from the C# DirewolfMod128Interop's PNTEST so the
// two suites can run against the same shared docker stack without an address
// collision (Dire Wolf's AFSK channel is a broadcast bus).
const OUR_CALL = Callsign.parse("PNTSTS-1");

// The AGW echo helper registers these (compose's AGW_REGISTER); we connect to
// the bidirectional-echo one to exercise both the connect and the round-trip.
const ECHO_CALL = Callsign.parse("PNDWBI");

// Tier-3 (software-AFSK, load-sensitive) budgets, matched to the C# sibling's
// 40 s connect / 40 s data / 30 s disconnect. The data awaiter / waitUntil
// return as soon as the predicate holds, so the headroom is free on a quiet host.
const CONNECT_BUDGET_MS = 40_000;
const DATA_BUDGET_MS = 40_000;
const DISCONNECT_BUDGET_MS = 30_000;

async function direwolfReachable(): Promise<boolean> {
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
      socket = createConnection({ host: HOST, port: DIREWOLF_KISS_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 200);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await direwolfReachable();

describe.skipIf(!stackReachable)(
  "ax25-ts mod-128 (extended) success path against Dire Wolf over AFSK1200",
  () => {
    let listener: Ax25Listener | null = null;
    let tap: ExtendedRxTap | null = null;

    beforeEach(() => {
      // Wrap the KISS transport in a tap that re-decodes inbound bytes at
      // modulo-128 (the C# rig's `Observed`-log equivalent — see file header).
      tap = new ExtendedRxTap(new TcpKissTransport(HOST, DIREWOLF_KISS_PORT, { kissPort: 0 }));
      listener = new Ax25Listener(tap, { myCall: OUR_CALL });
    });

    afterEach(async () => {
      try {
        await listener?.dispose();
      } catch {
        // best-effort — already-disconnected, etc.
      }
      listener = null;
      tap = null;
    });

    // C# cases (a)+(b) fused: connect extended, prove the link is genuinely
    // mod-128 (context + 2-octet wire control field), round-trip a payload BOTH
    // directions via the AGW echo, then clean disconnect. Fusing the connect-only
    // (C# case a) and the bidirectional transfer (C# case b) is cheaper on the
    // shared Tier-3 channel and still proves every assertion both cases carry.
    it(
      "ExtendedConnect_DirewolfAnswersUaAtMod128_RoundTrips_ThenDisconnects",
      async () => {
        await listener!.start();

        // Dial EXTENDED: connect(remote, true) routes the connect through
        // figc4.6 AwaitingV22Connection and emits a SABME (the inlined
        // Establish_Data_Link modulo branch). Dire Wolf answers UA at mod-128
        // (set_version_2_2) — no FRMR/DM fallback, unlike BPQ/XRouter — so the
        // promise resolves on a genuinely extended Connected link.
        const session: Ax25ListenerSession = await listener!.connect(
          ECHO_CALL,
          /* extended */ true,
        );

        expect(session.state).toBe("Connected");
        // The link is genuinely extended: no fallback fired, so isExtended is
        // still true. (BPQ's FRMR / XRouter's DM would have forced it false —
        // the fallback-suite assertion.)
        expect(session.context.isExtended).toBe(true);

        // Wire evidence #1: Dire Wolf answered our SABME with a UA (not a DM —
        // it is v2.2-capable on the incoming path). U-frames are one control
        // octet in both moduli, so the mod-8 tap reads them correctly.
        expect(tap!.observed.some((f) => classify(f) === "UA")).toBe(true);
        expect(tap!.observed.some((f) => classify(f) === "DM")).toBe(false);

        // ─── Bidirectional round-trip via the AGW echo helper ───────────
        const echo = new ChunkAwaiter();
        session.onData((chunk) => echo.push(chunk));

        const payload = new TextEncoder().encode("mod128-roundtrip-via-direwolf");
        await session.write(payload);

        // Wait for OUR payload to come back (forward leg us → Dire Wolf, reverse
        // leg the AGW echo bounces it → us).
        const received = await echo.waitForMatch(payload, DATA_BUDGET_MS);
        expect(received).not.toBeNull();

        // Wire evidence #2 (the headline): at least one I-frame Dire Wolf sent
        // us, re-decoded at modulo-128 by the tap, has a TWO-OCTET (extended)
        // control field — 7-bit N(S)/N(R) sequencing on the wire, i.e. genuinely
        // modulo-128, not modulo-8 (a mod-8 I-frame has a single control octet).
        expect(
          tap!.observed.some((f) => classify(f) === "I" && isExtendedControl(f)),
        ).toBe(true);

        // ─── Clean disconnect ───────────────────────────────────────────
        await session.disconnect();
        await waitUntil(() => session.state === "Disconnected", DISCONNECT_BUDGET_MS);
        expect(session.state).toBe("Disconnected");
      },
      // Superset of the connect + data + disconnect sub-budgets; a quiet run
      // finishes in well under 20 s.
      CONNECT_BUDGET_MS + DATA_BUDGET_MS + DISCONNECT_BUDGET_MS + 15_000,
    );
  },
);

/**
 * Thin {@link Ax25Transport} decorator that records every inbound frame
 * re-decoded at **modulo-128**, alongside forwarding the raw bytes unchanged to
 * the wrapped listener. This is the on-the-wire-proof seam: the listener's own
 * pump (and `onFrameTraced`) parses inbound frames at modulo-8 for routing and
 * only re-decodes at the session modulo internally, so the public trace surface
 * can't show a mod-128 I-frame's 2-octet control field. Re-decoding here mirrors
 * the C# `DirewolfMod128Interop` rig's `InboundPump`, which builds its `Observed`
 * log by parsing at `Context.IsExtended`. Frames that don't decode at mod-128
 * (none should, on a mod-128 link) are skipped — they still reach the listener
 * verbatim, so routing is unaffected.
 */
class ExtendedRxTap implements Ax25Transport {
  readonly observed: Ax25Frame[] = [];

  constructor(private readonly inner: Ax25Transport) {}

  async start(onFrame: (axBytes: Uint8Array) => void): Promise<void> {
    await this.inner.start((bytes) => {
      try {
        this.observed.push(decodeFrame(bytes, /* extended */ true, LENIENT_PARSE));
      } catch {
        // Not decodable at mod-128 — not our wire proof; the listener still
        // gets the verbatim bytes below and does its own routing parse.
      }
      onFrame(bytes);
    });
  }

  send(axBytes: Uint8Array): Promise<void> {
    return this.inner.send(axBytes);
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${budgetMs}ms`);
}

/**
 * Bounded queue + a "wait for a chunk matching `expected`" promise. The data
 * listener pushes chunks; the test pulls until one byte-equals the payload it
 * sent (the AGW echo bounces our exact payload back). Mirrors the C#
 * `WaitForMatchingData`.
 */
class ChunkAwaiter {
  private readonly queue: Uint8Array[] = [];
  private waiter: {
    expected: Uint8Array;
    resolve: (chunk: Uint8Array) => void;
  } | null = null;

  push(chunk: Uint8Array): void {
    if (this.waiter && bytesEqual(chunk, this.waiter.expected)) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(chunk);
      return;
    }
    this.queue.push(chunk);
  }

  async waitForMatch(expected: Uint8Array, budgetMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.find((c) => bytesEqual(c, expected));
    if (queued) return queued;
    return new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, budgetMs);
      this.waiter = {
        expected,
        resolve: (chunk) => {
          clearTimeout(timer);
          resolve(chunk);
        },
      };
    });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
