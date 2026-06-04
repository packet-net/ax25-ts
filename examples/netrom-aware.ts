/**
 * NET/ROM read-only "node aware" example — `NetRomService` taps an
 * `Ax25Listener`'s frame trace, hears a NODES routing broadcast, builds a
 * routing table, and prints it. It transmits nothing: it's a pure consumer of
 * the pre-address-filter frame trace, so a NODES broadcast addressed to the
 * literal callsign `NODES` (not to us) is heard without us ever replying.
 *
 * Pattern:
 *   1. Paired in-memory transports — bytes sent on side A arrive on B and
 *      vice versa.
 *   2. Wire `Ax25Listener` + `NetRomService` to side A (our node).
 *   3. Drive a hand-rolled peer on side B that broadcasts a NODES UI frame
 *      (the production library never *originates* a NODES broadcast — it's
 *      read-only — so the example hand-encodes the info field, exactly as the
 *      tests do).
 *   4. Observe the service learn the neighbour + the advertised destination,
 *      and print the snapshot (the analogue of a node's `NODES` command).
 *
 * Run with `tsx examples/netrom-aware.ts` after `npm install`.
 */
import { Callsign } from "../src/callsign.js";
import { ADDRESS_ENCODED_LENGTH, writeAddress } from "../src/address.js";
import { PID_NET_ROM, encodeFrame, ui } from "../src/frame.js";
import { Ax25Listener } from "../src/listener.js";
import {
  NETROM_ALIAS_LENGTH,
  NODES_SIGNATURE,
  NetRomService,
} from "../src/netrom/index.js";
import { MockTransport, pair } from "../tests/mock-transport.js";

// ── Hand-encode a NODES info field (read-only lib never originates one) ──────

function encodeShifted(call: Callsign): number[] {
  const bytes = new Uint8Array(ADDRESS_ENCODED_LENGTH);
  writeAddress(bytes, 0, { callsign: call, crhBit: false, extensionBit: false });
  return Array.from(bytes);
}

function encodeAlias(alias: string): number[] {
  const bytes = new Uint8Array(NETROM_ALIAS_LENGTH).fill(0x20);
  for (let i = 0; i < Math.min(alias.length, NETROM_ALIAS_LENGTH); i++) {
    bytes[i] = alias.charCodeAt(i) & 0xff;
  }
  return Array.from(bytes);
}

/** 0xFF signature + 6-byte sender alias + one 21-byte destination entry. */
function buildNodesInfo(
  senderAlias: string,
  dest: Callsign,
  destAlias: string,
  via: Callsign,
  quality: number,
): Uint8Array {
  return Uint8Array.from([
    NODES_SIGNATURE,
    ...encodeAlias(senderAlias),
    ...encodeShifted(dest),
    ...encodeAlias(destAlias),
    ...encodeShifted(via),
    quality & 0xff,
  ]);
}

async function main(): Promise<void> {
  const nodeCall = Callsign.parse("M0LTE-1"); // our node
  const neighbour = Callsign.parse("GB7RDG"); // the NODES broadcaster
  const destSot = Callsign.parse("GB7SOT"); // a destination it advertises
  const viaXyz = Callsign.parse("GB7XYZ-2"); // its chosen best-neighbour for SOT

  const { a, b } = pair();

  // Our node: a listener + the read-only NET/ROM service tapping its frame trace.
  const listener = new Ax25Listener(a, { myCall: nodeCall });
  const netrom = new NetRomService(); // enabled by default
  netrom.attachPort("vhf", nodeCall, listener);
  await listener.start();
  // Bring the peer's end up too (it must be running to send).
  await b.start(() => {});

  // The peer (side B) broadcasts: GB7RDG (alias RDGBPQ) can reach GB7SOT (alias
  // SOT) via GB7XYZ-2 at quality 200. UI frame, PID 0xCF, destination "NODES".
  const info = buildNodesInfo("RDGBPQ", destSot, "SOT", viaXyz, 200);
  const nodes = ui({
    destination: new Callsign("NODES", 0),
    source: neighbour,
    info,
    pid: PID_NET_ROM,
    isCommand: true,
  });
  await b.send(encodeFrame(nodes));

  // Give the inbound pump a tick to deliver + ingest.
  await new Promise((r) => setTimeout(r, 50));

  // Print the learned topology — the analogue of a node's `NODES` command.
  const snap = netrom.snapshot();
  console.log(`NET/ROM neighbours (${snap.neighbours.length}):`);
  for (const n of snap.neighbours) {
    console.log(`  ${n.alias || n.neighbour.toString()} on ${n.portId} q${n.pathQuality}`);
  }
  console.log(`NET/ROM routes (${snap.destinations.length}):`);
  for (const d of snap.destinations) {
    const r = d.bestRoute;
    const label = d.alias ? `${d.alias}:${d.destination}` : d.destination.toString();
    console.log(
      r ? `  ${label} via ${r.neighbour} q${r.quality} obs${r.obsolescence}` : `  ${label} (no route)`,
    );
  }

  // The read-only guarantee in action: we transmitted nothing in response.
  console.log(`\nframes our node transmitted: ${a.sent.length} (read-only — expected 0)`);

  netrom.dispose();
  await listener.dispose();
  await b.stop();
}

void MockTransport; // imported for its type alongside pair()
main().catch((err) => {
  console.error("example failed:", err);
});
