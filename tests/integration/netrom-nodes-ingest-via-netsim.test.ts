/**
 * Read-only NET/ROM interop against the live docker stack via net-sim.
 *
 * Parity with the C# `NetRomNodesIngestViaNetsim`
 * (`tests/Packet.Interop.Tests/Netsim/NetRomNodesIngestViaNetsim.cs` in
 * m0lte/packet.net, PR #305). Proves the TS `@packet-net/ax25` netrom module
 * ingests REAL reference-node NODES broadcasts off the wire and builds routing
 * state from them — exactly the C# read-only slice, in TypeScript.
 *
 * The production pipeline under test: a real {@link Ax25Listener} attached to
 * net-sim's afsk1200 KISS-TCP listener (127.0.0.1:8100, node `a`) → its
 * frame-trace tap → {@link NetRomService} → {@link NetRomRoutingTable} →
 * snapshot. **No transmit, no session, no engine change** — the listener is a
 * pure promiscuous receiver (the trace tap fires for every parsed RX frame
 * *before* address filtering, so NODES broadcasts addressed to the literal
 * callsign `NODES`, not to us, are heard).
 *
 * Two reference peers, both proven, exactly mirroring the C# test:
 *
 *   - **XRouter — ambient.** XRouter (NODECALL `PN0XRT`, alias `PNXRT`, node
 *     `d` / netsim 8103) broadcasts NODES on its pinned `NODESINTERVAL=1`
 *     cadence regardless of table contents, so we hear it passively.
 *   - **LinBPQ — provoked.** LinBPQ (`PN0TST`/`PNTST`, node `c` / netsim 8102)
 *     advertises NODES out a port only when that port has a non-zero QUALITY
 *     (the fixture sets `QUALITY=192`). We force an *immediate* broadcast with
 *     the sysop `SENDNODES` command, after authenticating with BPQ's real
 *     positional-challenge `PASSWORD` handshake — porting the C# `BpqSysop`
 *     driver below. We authenticate as the deliberately *non-sysop* telnet user
 *     `netop` so the genuine challenge runs (the `admin`/SYSOP user is a
 *     Secure_Session and would shortcut `PASSWORD` to an instant Ok, bypassing
 *     the mechanism we want to prove). `SENDNODES` then emits an immediate
 *     `PN0TST > NODES` UI frame on the netsim port.
 *
 * Hearing each node's NODES makes the service record it as a directly-heard
 * neighbour (with the node's advertised alias) carrying the assumed
 * default-port path quality, plus an assumed direct route to it (canonical
 * processing heuristics 3 + 4). That is genuine cross-implementation evidence
 * that the TS netrom module parses a real NET/ROM node's on-the-wire broadcast
 * and builds routing state from it, for both reference peers.
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 *
 * The describe block is gated on `127.0.0.1:8100` being reachable — if you
 * don't have docker up, the whole file is `describe.skipIf`-skipped, so this is
 * safe to leave wired into CI / local dev.
 *
 * The C# test uses `PNTEST` (no SSID) as the listener's own call; we use
 * `PNTEST-2` to dodge any chance of address collision when the two suites run
 * concurrently against the same docker stack (the existing TS connect test
 * already uses `PNTEST-1`). Our own call only matters for the listener's
 * session-layer address filter and the netrom trivial-loop guard — neither
 * reference node advertises us, so the value is otherwise immaterial.
 */
import { Socket, createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { Ax25Listener } from "../../src/listener.js";
import { NetRomService } from "../../src/netrom/service.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";

const HOST = "127.0.0.1";
const OUR_KISS_PORT = 8100; // net-sim node `a` — the shared "ours" endpoint
const BPQ_TELNET_PORT = 8010; // LinBPQ node prompt

const OUR_CALL = "PNTEST-2";
const XROUTER_CALL = "PN0XRT";
const XROUTER_ALIAS = "PNXRT";
const BPQ_CALL = "PN0TST";
const BPQ_ALIAS = "PNTST";

// The configured sysop password text (docker/linbpq/bpq32.cfg PASSWORD=).
// BPQ uppercases it, so the challenge solves against this exact string.
const BPQ_PASSWORD_TEXT = "WONTLISTEN";

// XRouter broadcasts NODES on a steady ~75 s cadence (NODESINTERVAL=1 pinned),
// so this window catches one ambient broadcast with margin.
const XROUTER_HEAR_BUDGET_MS = 200_000;

// LinBPQ is provoked via SENDNODES (immediate), so its budget is much tighter
// than XRouter's ambient cadence — generous-but-bounded so a single dropped
// frame on the sim channel still passes (we re-trigger inside the budget) and a
// genuinely-deaf node fails rather than hangs.
const BPQ_HEAR_BUDGET_MS = 90_000;
const BPQ_RESEND_EVERY_MS = 12_000;

/**
 * Quick probe: dial host:port with a 200 ms budget. If it connects, the docker
 * stack is up — return true. Otherwise the describe block self-skips. (Identical
 * to the guard in `linbpq-via-netsim.test.ts`.)
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
      socket = createConnection({ host: HOST, port: OUR_KISS_PORT });
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
  "netrom: read-only NODES ingest against XRouter + LinBPQ over net-sim",
  () => {
    it(
      "hears both reference nodes' NODES broadcasts and learns them as neighbours",
      async () => {
        const transport = new TcpKissTransport(HOST, OUR_KISS_PORT, {
          // net-sim's listener is on KISS port 0 (same as the other tests).
          kissPort: 0,
        });

        // The production pipeline: a real listener on the channel, plus the
        // node-level NET/ROM service subscribed to its frame-trace tap. The
        // listener never transmits here (we don't connect to anyone) — it is a
        // pure promiscuous receiver, exactly the read-only slice.
        const listener = new Ax25Listener(transport, { myCall: OUR_CALL });
        const netRom = new NetRomService({ enabled: true });
        netRom.attachPort("vhf", OUR_CALL, listener);

        try {
          await listener.start();

          // ── XRouter: ambient broadcast ──────────────────────────────
          // Wait until we've heard at least one real NODES broadcast and built a
          // neighbour entry. XRouter's steady cadence makes this the reliable
          // first observation.
          await waitUntil(
            () =>
              netRom
                .snapshot()
                .neighbours.some((n) => callMatches(n.neighbour, XROUTER_CALL)),
            XROUTER_HEAR_BUDGET_MS,
          );

          dumpSnapshot(netRom, "after XRouter window");

          const xr = netRom
            .snapshot()
            .neighbours.find((n) => callMatches(n.neighbour, XROUTER_CALL));
          expect(
            xr,
            "the TS netrom service should hear XRouter's NODES broadcast (PN0XRT) and learn it as a neighbour",
          ).toBeDefined();
          expect(
            xr!.alias,
            "the neighbour entry carries XRouter's advertised alias",
          ).toBe(XROUTER_ALIAS);
          expect(xr!.portId).toBe("vhf");
          expect(
            netRom
              .snapshot()
              .destinations.some((d) => callMatches(d.destination, XROUTER_CALL)),
            "an assumed direct route to the heard originator is built (canonical heuristic 4)",
          ).toBe(true);

          // ── LinBPQ: provoked via PASSWORD → SENDNODES ────────────────
          // Force an immediate NODES broadcast from the real LinBPQ and assert we
          // ingest BPQ's frame too. We re-trigger SENDNODES on a short cadence
          // inside the bounded budget so a single dropped frame on the simulated
          // channel doesn't fail the run.
          const heardBpq = await provokeAndHearBpq(netRom);

          dumpSnapshot(netRom, "after BPQ provoke");

          expect(
            heardBpq,
            "the TS netrom service must hear LinBPQ's NODES broadcast (PN0TST) after the PASSWORD->SENDNODES sysop handshake forces one onto the netsim channel",
          ).toBe(true);

          const bpq = netRom
            .snapshot()
            .neighbours.find((n) => callMatches(n.neighbour, BPQ_CALL));
          expect(
            bpq,
            "the TS netrom service should hear LinBPQ's NODES broadcast (PN0TST) and learn it as a neighbour",
          ).toBeDefined();
          expect(
            bpq!.alias,
            "the neighbour entry carries LinBPQ's advertised alias",
          ).toBe(BPQ_ALIAS);
          expect(bpq!.portId).toBe("vhf");
          expect(
            netRom
              .snapshot()
              .destinations.some((d) => callMatches(d.destination, BPQ_CALL)),
            "an assumed direct route to LinBPQ is built (canonical heuristic 4)",
          ).toBe(true);
        } finally {
          netRom.dispose();
          await listener.stop().catch(() => {
            // best-effort — already-stopped, etc.
          });
        }
      },
      // The XRouter ambient window dominates; give the whole test the sum of
      // both budgets plus a teardown beat.
      XROUTER_HEAR_BUDGET_MS + BPQ_HEAR_BUDGET_MS + 60_000,
    );
  },
);

/** Case-insensitive base+SSID match against a `"BASE-SSID"` (or bare `"BASE"`) string. */
function callMatches(actual: Callsign, expected: string): boolean {
  return actual.toString().toUpperCase() === Callsign.parse(expected).toString().toUpperCase();
}

function dumpSnapshot(netRom: NetRomService, when: string): void {
  const snap = netRom.snapshot();
  // eslint-disable-next-line no-console
  console.log(
    `[${when}] ${snap.neighbours.length} neighbour(s), ${snap.destinations.length} destination(s):`,
  );
  for (const n of snap.neighbours) {
    // eslint-disable-next-line no-console
    console.log(
      `  neighbour ${n.alias}:${n.neighbour.toString()} port=${n.portId} qual=${n.pathQuality}`,
    );
  }
  for (const d of snap.destinations) {
    const routes = d.routes
      .map((r) => `via ${r.neighbour.toString()} q${r.quality} obs${r.obsolescence}`)
      .join(", ");
    // eslint-disable-next-line no-console
    console.log(`  dest ${d.alias}:${d.destination.toString()} [${routes}]`);
  }
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(250);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive LinBPQ's sysop `SENDNODES` via the real positional-challenge `PASSWORD`
 * handshake, then wait (bounded) for the service to ingest the resulting
 * `PN0TST` NODES broadcast. Re-triggers `SENDNODES` on a short cadence inside
 * the budget for resilience against a dropped frame. Mirrors the C#
 * `ProvokeAndHearBpqAsync`.
 */
async function provokeAndHearBpq(netRom: NetRomService): Promise<boolean> {
  const deadline = Date.now() + BPQ_HEAR_BUDGET_MS;
  let nextResend = 0; // trigger immediately on entry

  const heard = (): boolean =>
    netRom.snapshot().neighbours.some((n) => callMatches(n.neighbour, BPQ_CALL));

  while (Date.now() < deadline) {
    if (heard()) {
      return true;
    }

    if (Date.now() >= nextResend) {
      try {
        await bpqSendNodes(
          HOST,
          BPQ_TELNET_PORT,
          "netop",
          "netop",
          BPQ_PASSWORD_TEXT,
        );
      } catch (err) {
        // A transient telnet hiccup must not sink the test outright — log and
        // let the next resend tick retry within budget.
        // eslint-disable-next-line no-console
        console.log(
          `SENDNODES trigger failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      nextResend = Date.now() + BPQ_RESEND_EVERY_MS;
    }

    await delay(250);
  }

  return heard();
}

// ─── Minimal IAC-aware telnet driver for LinBPQ's node prompt ──────────────
// Performs the real positional-challenge sysop auth and issues SENDNODES.
// Direct port of the C# `BpqSysop` nested class. The handshake (source-verified
// against LinBPQ 6.0.25.23, see the file header): log in as a non-sysop user →
// `PASSWORD` (bare) → BPQ replies with five 1-based positions → answer
// `PASSWORD <chars-at-those-positions>` → BPQ replies `Ok` (authorised) →
// `SENDNODES` → `Ok` + an immediate NODES broadcast on every non-zero-QUALITY
// port (the netsim port carries QUALITY=192 in the fixture for exactly this).

const IAC = 255,
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251;

async function bpqSendNodes(
  host: string,
  port: number,
  user: string,
  pass: string,
  passwordText: string,
): Promise<void> {
  const conn = await openTelnet(host, port);
  try {
    // Log in as the non-sysop user (plain session → real challenge).
    await conn.readUntil("user", 8_000);
    await conn.sendLine(user);
    await conn.readUntil("password", 8_000);
    await conn.sendLine(pass);
    await conn.readUntil("Telnet Server", 8_000);

    // Bare PASSWORD → positional challenge.
    await conn.sendLine("PASSWORD");
    const challenge = await conn.readLineAfterPrompt(6_000);
    const positions = parsePositions(challenge);
    const answer = solveChallenge(positions, passwordText);
    // eslint-disable-next-line no-console
    console.log(`BPQ PASSWORD challenge ${positions.join(" ")} -> answer ${answer}`);

    // Answer goes back as an ARGUMENT to a second PASSWORD command — a bare
    // token would be parsed as an unknown command.
    await conn.sendLine("PASSWORD " + answer);
    const authResp = await conn.readLineAfterPrompt(6_000);
    if (!authResp.includes("Ok")) {
      throw new Error(`BPQ rejected the PASSWORD challenge answer: ${authResp.trim()}`);
    }

    // Now authorised — force an immediate NODES broadcast.
    await conn.sendLine("SENDNODES");
    const sendResp = await conn.readLineAfterPrompt(6_000);
    if (!sendResp.includes("Ok") || sendResp.includes("SYSOP")) {
      throw new Error(`BPQ did not accept SENDNODES: ${sendResp.trim()}`);
    }

    // Hold the socket open a beat so BPQ doesn't abandon the command. The NODES
    // broadcast is independent of this telnet session.
    await delay(300);
  } finally {
    conn.close();
  }
}

function parsePositions(challenge: string): number[] {
  // The challenge line is "<prompt>} 5 3 6 3 3". The prompt prefix can contain a
  // digit (PN0TST), so take the LAST five integers.
  const nums = (challenge.match(/\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
  if (nums.length < 5) {
    throw new Error(`Could not parse 5 challenge positions from: ${challenge.trim()}`);
  }
  return nums.slice(-5);
}

function solveChallenge(positions: number[], passwordText: string): string {
  let answer = "";
  for (const p of positions) {
    // BPQ prints 1-based positions; the char summed is passwordText[p-1].
    // Positions are rand() % PWLen so always within range, but clamp
    // defensively rather than throw on a surprise.
    const idx = Math.min(Math.max(p - 1, 0), passwordText.length - 1);
    answer += passwordText[idx];
  }
  return answer;
}

interface TelnetConn {
  sendLine(line: string): Promise<void>;
  readUntil(needle: string, budgetMs: number): Promise<string>;
  readLineAfterPrompt(budgetMs: number): Promise<string>;
  close(): void;
}

/**
 * Open a TCP socket to BPQ's telnet port and wrap it in an IAC-stripping
 * reader/writer. Buffers all decoded text so reads never miss bytes that
 * arrived between calls; replies WONT/DONT to IAC DO/WILL so BPQ doesn't block
 * waiting on us.
 */
async function openTelnet(host: string, port: number): Promise<TelnetConn> {
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port });
    const onErr = (e: Error) => {
      s.off("connect", onOk);
      reject(e);
    };
    const onOk = () => {
      s.off("error", onErr);
      resolve(s);
    };
    s.once("connect", onOk);
    s.once("error", onErr);
  });

  // Decoded (IAC-stripped) text accumulates here; reads consume from it.
  let decoded = "";
  socket.on("data", (chunk: Buffer) => {
    decoded += appendStripIac(socket, chunk);
  });
  socket.on("error", () => {
    // swallowed — reads time out and surface as their own errors
  });

  const readMatching = async (
    stop: (buf: string) => boolean,
    budgetMs: number,
  ): Promise<string> => {
    const deadline = Date.now() + budgetMs;
    const startLen = decoded.length;
    while (Date.now() < deadline) {
      const slice = decoded.slice(startLen);
      if (stop(slice)) return slice;
      await delay(50);
    }
    return decoded.slice(startLen);
  };

  return {
    async sendLine(line: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(line + "\r", "ascii"), (err) =>
          err ? reject(err) : resolve(),
        );
      });
    },
    readUntil(needle: string, budgetMs: number): Promise<string> {
      return readMatching((buf) => needle.length > 0 && buf.includes(needle), budgetMs);
    },
    readLineAfterPrompt(budgetMs: number): Promise<string> {
      // BPQ terminates a command reply with \r\n; stop once we have one.
      return readMatching((buf) => buf.includes("\n"), budgetMs);
    },
    close(): void {
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Strip IAC negotiation from a chunk, replying WONT/DONT so BPQ doesn't wait on
 * us, and return the printable text. Direct port of the C# `AppendStripIac`.
 */
function appendStripIac(socket: Socket, buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== IAC) {
      out += String.fromCharCode(buf[i]!);
      continue;
    }
    if (i + 2 >= buf.length) break; // partial IAC at the tail — drop
    const verb = buf[i + 1]!;
    const opt = buf[i + 2]!;
    i += 2;
    const reply = verb === DO ? WONT : verb === WILL ? DONT : 0;
    if (reply !== 0) {
      try {
        socket.write(Buffer.from([IAC, reply, opt]));
      } catch {
        // best-effort
      }
    }
  }
  return out;
}
