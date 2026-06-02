/**
 * End-to-end interop against the live LinBPQ docker container via net-sim.
 * Modelled on the C# `LinbpqViaNetsimConnectedMode` test
 * (`tests/Packet.Interop.Tests/Linbpq/LinbpqViaNetsimConnectedMode.cs`):
 *
 *   - We attach our `TcpKissTransport` to net-sim's KISS-TCP listener on
 *     127.0.0.1:8100 (node `a`).
 *   - LinBPQ — running inside docker as `pn-linbpq`, NODECALL=PN0TST —
 *     dials net-sim from the docker network on 8102 (node `c`).
 *   - net-sim's afsk1200 sim bridges frames between the two nodes, so to
 *     `Ax25Stack` it looks like a normal AX.25 peer.
 *
 * This is the first proof that ax25.ts can interoperate with a real
 * third-party AX.25 stack (BPQ, mature C implementation, ~30 years of
 * provenance). The unit-test suite drives ax25.ts against itself via
 * paired MockTransports — that proves the SDL tables are internally
 * consistent but doesn't prove they wire-match a peer that wasn't built
 * from the same tables.
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 *
 * The describe block is gated on `127.0.0.1:8100` being reachable —
 * if you don't have docker up, the whole file is `describe.skipIf`-skipped
 * with a one-line "stack not up" reason, so this is safe to leave wired
 * into CI / local dev.
 *
 * The C# `PNTEST` (no SSID) is used by `LinbpqViaNetsimConnectedMode`;
 * we use `PNTEST-1` to dodge any chance of address collision when the two
 * test suites run concurrently against the same docker stack.
 */
import { Socket, createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { Ax25Stack } from "../../src/session.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";

const HOST = "127.0.0.1";
const PORT = 8100;

/**
 * Quick probe: dial host:port with a 200 ms budget. If it connects, the
 * docker stack is up — return true. Otherwise (timeout, ECONNREFUSED,
 * EHOSTUNREACH, …) return false and the describe block self-skips.
 */
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
      socket = createConnection({ host: HOST, port: PORT });
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
  "ax25.ts via TcpKissTransport against LinBPQ over net-sim",
  () => {
    // Each test owns its own stack + transport. Created in beforeEach so a
    // mid-test failure tears down promptly; afterEach is the safety net.
    let stack: Ax25Stack | null = null;
    let transport: TcpKissTransport | null = null;

    beforeEach(() => {
      transport = new TcpKissTransport(HOST, PORT, {
        // The same as the C# test — net-sim's listener is on port 0.
        kissPort: 0,
      });
      stack = new Ax25Stack(transport);
    });

    afterEach(async () => {
      try {
        await stack?.stop();
      } catch {
        // best-effort — already-disconnected, etc.
      }
      stack = null;
      transport = null;
    });

    it(
      "Connect_Then_Disconnect_Against_Linbpq_Across_Netsim",
      async () => {
        await stack!.start();

        // Use SSID 1 (PNTEST-1) so the existing C# test (PNTEST, SSID 0)
        // can run concurrently against the same docker stack without
        // address-collision.
        const from = Callsign.parse("PNTEST-1");
        const to = Callsign.parse("PN0TST");

        const session = await stack!.connect({ from, to });
        expect(session.from.toString()).toBe("PNTEST-1");
        expect(session.to.toString()).toBe("PN0TST");

        // We don't gate disconnect on receipt of the banner — some BPQ
        // configurations may suppress CTEXT or split it across many
        // frames; the Connect_Then_Disconnect test only asserts on the
        // handshake. The IFrame_RoundTrip test below asserts on banner +
        // command response.
        await session.disconnect();
      },
      30_000,
    );

    // #153 was #12 misdiagnosed: the CTEXT banner "never arrived" because
    // ax25-ts couldn't acknowledge the inbound I-frames (the figc4.7 subroutine
    // walker / delayed-ack flush was unwired), so BPQ's send window stalled
    // after the first frames. With #12 fixed this round-trips against LinBPQ:
    // receive the banner, send `P\r`, receive the response. (Closes #153.)
    it(
      "IFrame_RoundTrip_Against_Linbpq_Node_Prompt",
      async () => {
        await stack!.start();

        const from = Callsign.parse("PNTEST-1");
        const to = Callsign.parse("PN0TST");

        const session = await stack!.connect({ from, to });

        const received: Uint8Array[] = [];
        const dataAwaiter = new ChunkAwaiter();
        session.onData((chunk) => {
          received.push(chunk);
          dataAwaiter.push(chunk);
        });

        // BPQ's CTEXT banner is delivered as one or more I-frames right
        // after UA — wait up to 30s (was 15s, doubled to match the
        // NetsimUiFrameScenarios.RxBudget bump in the same PR — same
        // AFSK1200-sim-under-CPU-contention root cause).
        const banner = await dataAwaiter.waitForNext(30_000);
        expect(banner.length).toBeGreaterThan(0);

        // Drain any follow-up banner frames so they don't surface as
        // false matches for the command response we're about to send.
        await new Promise((r) => setTimeout(r, 1000));
        dataAwaiter.drain();

        // BPQ's `P\r` = "Ports" command at the node prompt — short,
        // deterministically non-empty response, no side effects.
        await session.write(new TextEncoder().encode("P\r"));

        const response = await dataAwaiter.waitForNext(30_000);
        expect(response.length).toBeGreaterThan(0);

        await session.disconnect();
      },
      45_000,
    );
  },
);

/**
 * Bounded queue + a one-shot "wait for next" promise. The data listener
 * pushes chunks; the test pulls one chunk at a time with a budget.
 */
class ChunkAwaiter {
  private readonly queue: Uint8Array[] = [];
  private resolver: ((chunk: Uint8Array) => void) | null = null;

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

  async waitForNext(budgetMs: number): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolver = null;
        reject(new Error(`no chunk received within ${budgetMs}ms`));
      }, budgetMs);
      this.resolver = (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      };
    });
  }
}
