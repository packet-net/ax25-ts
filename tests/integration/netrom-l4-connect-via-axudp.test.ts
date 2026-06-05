/**
 * Tier 2 (frame-perfect, modem-less) NET/ROM **L4 circuit** interop vs real LinBPQ
 * over AXUDP — the TS parity leg of the C#
 * `tests/Packet.Interop.Tests/Linbpq/NetRomL4CircuitViaAxudp.cs`, and the integration
 * proof for TS-4 (`connect <alias>` across the network).
 *
 * The production pipeline under test: a real {@link Ax25Listener} over an
 * {@link AxudpTransport} (BPQAXIP-over-UDP) carries the whole NET/ROM stack — a
 * {@link NetRomService} (ingest) hears BPQ's NODES, a {@link NetRomOriginator} (TX)
 * originates ours so BPQ learns + routes to us, and a {@link NetRomConnector} (L4)
 * opens a CONNECTED-mode interlink AX.25 session (PID 0xCF) over the tunnel and runs
 * an end-to-end L4 circuit. Two legs, mirroring the C# test:
 *
 *   1. **L3 both ways.** pdn originates NODES → BPQ learns it (queried via the sysop
 *      `ROUTES`/`NODES`), and pdn hears BPQ's `PNTST:PN0TST` (provoked via
 *      `PASSWORD` → `SENDNODES`) so it has a route to dial the circuit over.
 *   2. **L4 circuit pdn → BPQ (the core deliverable).**
 *      {@link NetRomConnector.connect} resolves BPQ as a destination, opens the
 *      interlink + originates an L4 circuit; a command round-trips to BPQ's node
 *      prompt over the circuit (BPQ's `PN0TST` identity relays back — Information both
 *      ways); then a clean Disconnect.
 *   3. **L4 circuit BPQ → pdn (reverse).** We drive BPQ's telnet `C PNTSA` so BPQ
 *      originates a circuit to pdn over AXIP; pdn's {@link NetRomConnector}
 *      `onIncomingConnection` fires, pdn bridges a tiny echo console, and a line
 *      round-trips.
 *
 * **The Connect-Request info-field framing** (the #308/#309 finding, re-asserted
 * frame-perfectly here): BPQ carries the proposed window + originating user/node in
 * the info field (`[window][user][node]`), not the transport-header TX byte — the
 * `ConnectRequestInfo` codec. The reverse-circuit `onIncomingConnection` reads BPQ's
 * originating user from exactly that field.
 *
 * **CI note.** ax25-ts's own CI is unit-only and does NOT run this file
 * (`test:integration` is excluded from `npm test`). The AXUDP interop is run by
 * **packet.net's `interop.yml`**, which clones ax25-ts `main` and runs
 * `test:integration` against its docker stack — so this test is exercised only after
 * this PR merges to ax25-ts main. The describe block self-skips when BPQ's telnet port
 * (8010) is unreachable, so it is a no-op anywhere the stack is down.
 *
 * (BPQAXIP delivers its own NODES over a point-to-point AXIP port only to a `B`-flagged
 * `BROADCAST NODES` MAP recipient it treats as a live neighbour; the fixture's
 * `MAP PNTSAX-1 … 8196 B` + `AUTOADDQUIET` provide that, reused from the AXUDP ingest
 * / origination tests per the slice brief — the three are serialised in interop.yml's
 * NET/ROM phase against the shared daemon.)
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 */
import { Socket, createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { Ax25Listener } from "../../src/listener.js";
import { AxudpTransport } from "../../src/axudp-transport.js";
import {
  NetRomConnector,
  type NetRomConnection,
  NetRomOriginator,
  NetRomRoutingTable,
  NetRomService,
  resolveDestination,
} from "../../src/netrom/index.js";

const HOST = "127.0.0.1";
const BPQ_AXUDP_PORT = 8093; // BPQAXIP/UDP listener (published)
const BPQ_TELNET_PORT = 8010; // LinBPQ node prompt

// pdn binds the static-MAP target port + uses the static-MAP target callsign so BPQ's
// reply route (static MAP + AUTOADD) is stable across re-runs.
const OUR_CALL = "PNTSAX-1"; // matches `MAP PNTSAX-1 … 8196 B` in bpq32.cfg
const OUR_ALIAS = "PNTSA";
const PDN_LOCAL_PORT = 8196; // the static-MAP target port

// LinBPQ's node identity over this fixture.
const BPQ_CALL = "PN0TST";
const BPQ_ALIAS = "PNTST";

// The configured sysop password text (docker/linbpq/bpq32.cfg PASSWORD=).
const BPQ_PASSWORD_TEXT = "WONTLISTEN";

// A reliable UDP tunnel — tight, bounded budgets (no channel loss / half-duplex).
const BROADCAST_EVERY_MS = 2_000;
const HEAR_BPQ_BUDGET_MS = 45_000;
const BPQ_RESEND_EVERY_MS = 8_000;
const BPQ_LEARNS_US_BUDGET_MS = 45_000;
const QUERY_EVERY_MS = 2_000;
const OUTBOUND_CONNECT_BUDGET_MS = 30_000;
const INBOUND_CIRCUIT_BUDGET_MS = 60_000;
const DATA_ROUND_TRIP_BUDGET_MS = 20_000;

/** Probe BPQ's telnet port — if it answers, the docker stack is up. */
async function bpqTelnetReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (ok: boolean): void => {
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
      socket = createConnection({ host: HOST, port: BPQ_TELNET_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 250);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await bpqTelnetReachable();

describe.skipIf(!stackReachable)(
  "netrom: L4 circuit against LinBPQ over AXUDP (Tier 2, frame-perfect)",
  () => {
    it(
      "originates NODES, opens an L4 circuit to BPQ both ways, exchanges data, and disconnects",
      async () => {
        // Bind all interfaces (NOT loopback) — BPQ replies via 172.30.0.1.
        const transport = new AxudpTransport(HOST, BPQ_AXUDP_PORT, {
          localPort: PDN_LOCAL_PORT,
        });
        const listener = new Ax25Listener(transport, { myCall: OUR_CALL });

        // The read-only ingest tap (hears BPQ's NODES → learns a route to it). It is
        // also the connector's routing view (NetRomService satisfies the connector's
        // RoutingSnapshotSource via its snapshot()).
        const netRom = new NetRomService();
        // The TX half (originate our NODES so BPQ learns + routes to us). BPQ learns
        // the *originator* of any NODES it accepts, so a header-only broadcast off a
        // fresh table is enough to make BPQ learn + route to us — exactly the
        // origination test's assertion — and keeps the originator's table independent
        // of the ingest tap's private one.
        const originator = new NetRomOriginator(new NetRomRoutingTable(), {
          enabled: true,
          alias: OUR_ALIAS,
          nodeCall: OUR_CALL,
        });
        // The L4 connector (the deliverable): resolves an alias → interlink → circuit.
        const connector = new NetRomConnector(netRom, {
          enabled: true,
          // Fast-ish L4 retransmit; on a lossless tunnel this rarely fires.
          circuit: { retransmitTimeoutMs: 4_000, maxRetries: 5 },
        });

        netRom.attachPort("axudp", OUR_CALL, listener);
        originator.attachPort("axudp", listener);
        connector.attachPort("axudp", OUR_CALL, listener);

        // Drive the circuit retransmit timers (embedder-owned, per the no-ambient-
        // timers design). 1 s cadence, matching the C# manager's tick.
        const tickTimer = setInterval(() => connector.tick(), 1_000);
        (tickTimer as { unref?: () => void }).unref?.();

        // Bridge an inbound NET/ROM circuit (BPQ → pdn) to a tiny echo console so we
        // observe onIncomingConnection AND prove data round-trips over the circuit.
        let inboundSeen: NetRomConnection | null = null;
        let inboundEchoed = false;
        connector.onIncomingConnection((conn) => {
          inboundSeen = conn;
          conn.onData((chunk) => {
            const text = new TextDecoder().decode(chunk);
            // eslint-disable-next-line no-console
            console.log(`inbound circuit RX: ${text.replace(/\r/g, "\\r")}`);
            conn.write(new TextEncoder().encode("ack:" + text));
            inboundEchoed = true;
          });
          conn.write(new TextEncoder().encode("pdn-l4\r"));
        });

        // Originate pdn's NODES on a steady cadence for the whole test (BPQ's
        // obsolescence + AUTOADD would otherwise decay). Embedder-driven loop.
        let broadcasting = true;
        const broadcastLoop = (async () => {
          while (broadcasting) {
            try {
              await originator.broadcastNodes();
            } catch {
              // best-effort
            }
            await delay(BROADCAST_EVERY_MS);
          }
        })();

        try {
          await listener.start();

          // ── L3 (a): pdn hears BPQ's NODES (so we have a route to BPQ) ──────
          const heardBpq = await provokeAndHearBpq(netRom);
          expect(
            heardBpq,
            "pdn must hear LinBPQ's NODES (PN0TST) over AXUDP so it has a NET/ROM route to dial the L4 circuit over",
          ).toBe(true);

          // ── L3 (b): BPQ learns pdn as a node + route ──────────────────────
          const bpqLearnedUs = await waitForBpqToLearnUs();
          expect(
            bpqLearnedUs,
            "LinBPQ must learn pdn as a NET/ROM node/route from pdn's originated NODES (checked via BPQ's ROUTES/NODES)",
          ).toBe(true);

          // ── L4 (1): pdn → BPQ circuit (the core deliverable) ──────────────
          const dest =
            resolveDestination(netRom.snapshot(), BPQ_ALIAS) ??
            resolveDestination(netRom.snapshot(), BPQ_CALL);
          expect(
            dest,
            "pdn resolves BPQ (alias PNTST / call PN0TST) as a NET/ROM destination to route to",
          ).not.toBeNull();

          // eslint-disable-next-line no-console
          console.log(
            `opening L4 circuit pdn -> ${dest!.destination} via ${dest!.bestRoute?.neighbour} (AXUDP)`,
          );
          const received: Uint8Array[] = [];
          const connection = await withTimeout(
            connector.connect(BPQ_ALIAS, OUR_CALL),
            OUTBOUND_CONNECT_BUDGET_MS,
            "outbound L4 connect pdn -> BPQ",
          );
          connection.onData((chunk) => received.push(chunk));
          try {
            expect(
              connector.circuitManager.circuits.length,
              "pdn holds the originating L4 circuit to BPQ",
            ).toBeGreaterThan(0);
            // eslint-disable-next-line no-console
            console.log("*** L4 circuit pdn -> BPQ ESTABLISHED over AXUDP ***");

            // Data round-trip (Information both ways): nudge the prompt, send a
            // sysop-free node command, accumulate BPQ's reply (carrying PN0TST).
            connection.write(new TextEncoder().encode("\r"));
            connection.write(new TextEncoder().encode("PORTS\r"));
            const reply = await accumulateUntil(
              received,
              "PN0TST",
              DATA_ROUND_TRIP_BUDGET_MS,
            );
            expect(
              reply.includes("PN0TST"),
              "a command sent over the L4 circuit reaches BPQ's node and the reply (carrying BPQ's PN0TST node identity) relays back — Information round-trips both directions over the circuit",
            ).toBe(true);
            // eslint-disable-next-line no-console
            console.log(
              `circuit data round-trip; reply contained BPQ identity. Sample: ${collapse(reply).slice(0, 160)}`,
            );
          } finally {
            connection.dispose();
          }
          await waitUntil(
            () =>
              connector.circuitManager.circuits.every(
                (c) => c.state === "Disconnected",
              ),
            15_000,
          );
          // eslint-disable-next-line no-console
          console.log("*** L4 circuit pdn -> BPQ DISCONNECTED cleanly ***");

          // ── L4 (2): BPQ → pdn circuit (reverse) ───────────────────────────
          const reverseEstablished = await driveBpqConnectAndData(
            () => inboundSeen !== null,
            () => inboundEchoed,
          );
          expect(
            reverseEstablished,
            "LinBPQ originates a NET/ROM L4 circuit to pdn (C <alias>) over AXUDP and pdn's connector raises onIncomingConnection",
          ).toBe(true);
          expect(inboundSeen, "the reverse circuit reached pdn").not.toBeNull();
          expect(
            inboundEchoed,
            "data round-trips over the BPQ -> pdn L4 circuit (BPQ relays a line; pdn's echo console replies over the circuit)",
          ).toBe(true);
          // eslint-disable-next-line no-console
          console.log(
            "*** L4 circuit BPQ -> pdn ESTABLISHED + data round-tripped over AXUDP ***",
          );
        } finally {
          broadcasting = false;
          await broadcastLoop.catch(() => {});
          clearInterval(tickTimer);
          connector.dispose();
          originator.dispose();
          netRom.dispose();
          await listener.stop().catch(() => {});
        }
      },
      HEAR_BPQ_BUDGET_MS + BPQ_LEARNS_US_BUDGET_MS + OUTBOUND_CONNECT_BUDGET_MS + INBOUND_CIRCUIT_BUDGET_MS + 90_000,
    );
  },
);

// ── L3: hear BPQ (provoke SENDNODES, bounded, re-trigger) ────────────────
async function provokeAndHearBpq(netRom: NetRomService): Promise<boolean> {
  const deadline = Date.now() + HEAR_BPQ_BUDGET_MS;
  const bpq = Callsign.parse(BPQ_CALL);
  let nextResend = 0;
  while (Date.now() < deadline) {
    if (netRom.snapshot().neighbours.some((n) => n.neighbour.equals(bpq))) {
      return true;
    }
    if (Date.now() >= nextResend) {
      try {
        await bpqSendNodes(HOST, BPQ_TELNET_PORT, BPQ_PASSWORD_TEXT);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `SENDNODES trigger failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      nextResend = Date.now() + BPQ_RESEND_EVERY_MS;
    }
    await delay(250);
  }
  return netRom.snapshot().neighbours.some((n) => n.neighbour.equals(bpq));
}

// ── L3: BPQ learns us (query its ROUTES/NODES via sysop session) ─────────
async function waitForBpqToLearnUs(): Promise<boolean> {
  const deadline = Date.now() + BPQ_LEARNS_US_BUDGET_MS;
  const ourBase = Callsign.parse(OUR_CALL).base.toUpperCase();
  let nextQuery = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextQuery) {
      try {
        const { nodes, routes } = await bpqQueryNodesAndRoutes(
          HOST,
          BPQ_TELNET_PORT,
          BPQ_PASSWORD_TEXT,
        );
        if (
          routes.toUpperCase().includes(ourBase) ||
          nodes.toUpperCase().includes(ourBase)
        ) {
          // eslint-disable-next-line no-console
          console.log(
            `BPQ learned us. NODES=[${collapse(nodes)}] ROUTES=[${collapse(routes)}]`,
          );
          return true;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `BPQ NODES/ROUTES query failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      nextQuery = Date.now() + QUERY_EVERY_MS;
    }
    await delay(250);
  }
  return false;
}

// ── L4: drive BPQ -> pdn connect (+ data) with bounded retry ─────────────
async function driveBpqConnectAndData(
  established: () => boolean,
  echoed: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + INBOUND_CIRCUIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (echoed()) {
      return true;
    }
    try {
      await bpqConnectAndSend(
        HOST,
        BPQ_TELNET_PORT,
        BPQ_PASSWORD_TEXT,
        OUR_ALIAS,
        "hello-from-bpq\r",
        20_000,
        established,
        echoed,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `BPQ C ${OUR_ALIAS} attempt failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (established() && echoed()) return true;
    await delay(2_000);
  }
  return established();
}

// ── helpers ──────────────────────────────────────────────────────────────
async function accumulateUntil(
  received: Uint8Array[],
  needle: string,
  budgetMs: number,
): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const text = received.map((b) => new TextDecoder().decode(b)).join("");
    if (text.includes(needle)) return text;
    await delay(100);
  }
  return received.map((b) => new TextDecoder().decode(b)).join("");
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(250);
  }
}

async function withTimeout<T>(p: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${budgetMs}ms`)),
      budgetMs,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── IAC-aware telnet driver for LinBPQ's node prompt ──────────────────────
// The source-verified positional-challenge sysop auth, plus the operations this test
// needs (SENDNODES, ROUTES/NODES query, and an outbound `C <alias>` + data-relay).
// A direct port of the C# `NetRomL4CircuitViaAxudp.BpqTelnet`.

const IAC = 255,
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251;

async function bpqSendNodes(host: string, port: number, passwordText: string): Promise<void> {
  const conn = await openTelnet(host, port);
  try {
    await authenticate(conn, passwordText);
    await conn.sendLine("SENDNODES");
    const resp = await conn.readLineAfterPrompt(6_000);
    if (!resp.includes("Ok") || resp.includes("SYSOP")) {
      throw new Error(`BPQ did not accept SENDNODES: ${resp.trim()}`);
    }
    await delay(300);
  } finally {
    conn.close();
  }
}

async function bpqQueryNodesAndRoutes(
  host: string,
  port: number,
  passwordText: string,
): Promise<{ nodes: string; routes: string }> {
  const conn = await openTelnet(host, port);
  try {
    await authenticate(conn, passwordText);
    await conn.sendLine("NODES");
    const nodes = await conn.readFor(3_000);
    await conn.sendLine("ROUTES");
    const routes = await conn.readFor(3_000);
    return { nodes, routes };
  } finally {
    conn.close();
  }
}

async function bpqConnectAndSend(
  host: string,
  port: number,
  passwordText: string,
  alias: string,
  payload: string,
  holdMs: number,
  established: () => boolean,
  echoed: () => boolean,
): Promise<void> {
  const conn = await openTelnet(host, port);
  try {
    await authenticate(conn, passwordText);
    await conn.sendLine("C " + alias);

    const deadline = Date.now() + holdMs;
    let payloadSent = false;
    while (Date.now() < deadline && !echoed()) {
      const acc = conn.buffered();
      if (!payloadSent && established() && /connected/i.test(acc)) {
        payloadSent = true;
        await delay(500);
        await conn.sendRaw(payload);
        // eslint-disable-next-line no-console
        console.log(`BPQ relayed payload over circuit: ${payload.replace(/\r/g, "\\r")}`);
      }
      await delay(200);
    }
  } finally {
    conn.close();
  }
}

async function authenticate(conn: TelnetConn, passwordText: string): Promise<void> {
  await conn.readUntil("user", 8_000);
  await conn.sendLine("netop");
  await conn.readUntil("password", 8_000);
  await conn.sendLine("netop");
  await conn.readUntil("Telnet Server", 8_000);

  await conn.sendLine("PASSWORD");
  const challenge = await conn.readLineAfterPrompt(6_000);
  const positions = parsePositions(challenge);
  const answer = solveChallenge(positions, passwordText);
  // eslint-disable-next-line no-console
  console.log(`BPQ PASSWORD challenge ${positions.join(" ")} -> answer ${answer}`);

  await conn.sendLine("PASSWORD " + answer);
  const authResp = await conn.readLineAfterPrompt(6_000);
  if (!authResp.includes("Ok")) {
    throw new Error(`BPQ rejected the PASSWORD challenge answer: ${authResp.trim()}`);
  }
}

function parsePositions(challenge: string): number[] {
  const nums = (challenge.match(/\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
  if (nums.length < 5) {
    throw new Error(`Could not parse 5 challenge positions from: ${challenge.trim()}`);
  }
  return nums.slice(-5);
}

function solveChallenge(positions: number[], passwordText: string): string {
  let answer = "";
  for (const p of positions) {
    const idx = Math.min(Math.max(p - 1, 0), passwordText.length - 1);
    answer += passwordText[idx];
  }
  return answer;
}

interface TelnetConn {
  sendLine(line: string): Promise<void>;
  sendRaw(text: string): Promise<void>;
  readUntil(needle: string, budgetMs: number): Promise<string>;
  readLineAfterPrompt(budgetMs: number): Promise<string>;
  readFor(budgetMs: number): Promise<string>;
  buffered(): string;
  close(): void;
}

async function openTelnet(host: string, port: number): Promise<TelnetConn> {
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port });
    const onErr = (e: Error): void => {
      s.off("connect", onOk);
      reject(e);
    };
    const onOk = (): void => {
      s.off("error", onErr);
      resolve(s);
    };
    s.once("connect", onOk);
    s.once("error", onErr);
  });

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
    async sendRaw(text: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(text, "ascii"), (err) => (err ? reject(err) : resolve()));
      });
    },
    readUntil(needle: string, budgetMs: number): Promise<string> {
      return readMatching((buf) => needle.length > 0 && buf.includes(needle), budgetMs);
    },
    readLineAfterPrompt(budgetMs: number): Promise<string> {
      return readMatching((buf) => buf.includes("\n"), budgetMs);
    },
    readFor(budgetMs: number): Promise<string> {
      return readMatching(() => false, budgetMs);
    },
    buffered(): string {
      return decoded;
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

function appendStripIac(socket: Socket, buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== IAC) {
      out += String.fromCharCode(buf[i]!);
      continue;
    }
    if (i + 2 >= buf.length) break;
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
