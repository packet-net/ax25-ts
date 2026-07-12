#!/usr/bin/env node
/**
 * Cross-repo parity drift guard: @packet-net/ax25 (this repo) vs the C#
 * reference implementation in m0lte/packet.net.
 *
 * The C# libraries are the reference runtime ("runtime behaviour questions
 * defer to the C# reference" — CLAUDE.md). Historically the TS side drifted
 * behind it silently: new named parse flags, session quirks, and listener
 * surface (the TEST/axping responder, the per-listener compat knobs) landed
 * in C# with no TS counterpart and nothing failed. This script makes that
 * drift a CI failure on BOTH sides:
 *
 *   - in this repo's ci.yml: a job shallow-clones packet.net main and runs
 *     this script — a TS PR can't merge while the inventories disagree;
 *   - in packet.net's interop.yml: the existing ax25-ts checkout runs the
 *     same script — a C# PR adding a named flag fails until the TS leg
 *     exists (or an exception is consciously recorded here first).
 *
 * What is compared (C# is the reference; the check is C# ⊆ TS modulo the
 * alias maps below; TS-only extras are reported as info, not failures):
 *
 *   1. Ax25ParseOptions flag inventory + preset inventory
 *   2. Ax25SessionQuirks flag inventory + preset inventory
 *   3. XidParseOptions flag inventory
 *   4. Ax25ListenerOptions member inventory
 *   5. Ax25Listener public method/event surface
 *
 * Intentional divergences live in scripts/parity-exceptions.json with a
 * reason each — an exception is a *reviewed decision*, not a hole. The guard
 * fails on any gap that is neither aliased nor excepted.
 *
 * ── The optional third leg: C# ⊆ Rust (pico-node) ─────────────────────
 *
 * With `--rust <pico-node root>` this script becomes a TRUE 3-way mirror
 * (C# authoritative ↔ TS @packet-net/ax25 ↔ Rust pico-node). The Rust leg
 * reuses the SAME live C# inventory extracted above (single C# source of
 * truth — pico-node's C# side is NOT re-vendored or hard-coded here), then
 * reads pico-node's declared position:
 *
 *   - parity-manifest.toml            — opted-in / declared-out vector sets
 *                                        and the capabilities each declares;
 *   - parity/expected-inventory.json  — the map from each C# inventory item
 *                                        (section + name) to the vector-set /
 *                                        capability that covers it;
 *   - parity-exceptions.json          — reviewed, reason-carrying omissions.
 *
 * and asserts C#-inventory ⊆ pico-node-declared exactly as pico-node's own
 * scripts/parity-check.mjs does: every live C# item is EITHER mapped (in
 * expected-inventory.json) to an opted-in set whose capabilities include the
 * named one, OR listed in parity-exceptions.json with a reason. Anything that
 * is neither is drift and fails the build. Because the item LIST comes from
 * live C# extraction (not pico-node's vendored snapshot), this leg also bites
 * when C# grows an item pico-node's manifest+snapshot don't yet cover — it
 * keeps that vendored snapshot honest. Without `--rust`, behaviour is
 * identical to before (backward-compatible).
 *
 * Extraction is regex-over-source on purpose: no build of either repo is
 * needed, so the check runs in seconds on a shallow sparse clone. It leans
 * on both repos' stable formatting (root-level class braces at column 0,
 * one property per line). If a refactor breaks extraction the guard fails
 * loudly with "inventory came back empty" — fix the regex, don't skip the
 * check.
 *
 * Usage: node scripts/parity-check.mjs --csharp <packet.net root> [--ts <ax25-ts root>] [--rust <pico-node root>]
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const tsRoot = argValue("--ts", join(dirname(fileURLToPath(import.meta.url)), ".."));
const csRoot = argValue("--csharp", null);
const rustRoot = argValue("--rust", null);
if (!csRoot) {
  console.error("usage: parity-check.mjs --csharp <packet.net root> [--ts <ax25-ts root>] [--rust <pico-node root>]");
  process.exit(2);
}

const exceptions = JSON.parse(
  readFileSync(join(tsRoot, "scripts", "parity-exceptions.json"), "utf8"),
);

const read = (p) => readFileSync(p, "utf8");
const camel = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** All `public bool X { get; init; }` property names in a C# file. */
function csBoolProps(text) {
  return [...text.matchAll(/^\s*public bool (\w+)\s*\{\s*get;/gm)].map((m) => m[1]);
}

/** All `public static <Type> X { get; }` preset names in a C# file. */
function csStaticPresets(text, type) {
  const re = new RegExp(`^\\s*public static ${type} (\\w+)\\s*\\{\\s*get;`, "gm");
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** Member names of a named TS interface (one `readonly x?: T;` / `x?: T;` per line). */
function tsInterfaceMembers(text, name) {
  const start = text.indexOf(`export interface ${name}`);
  if (start < 0) return [];
  const body = sliceBalanced(text, text.indexOf("{", start));
  return [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*[:(]/gm)].map((m) => m[1]);
}

/** Slice a balanced `{ … }` block starting at the given `{` index. */
function sliceBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(openIdx + 1, i);
  }
  return text.slice(openIdx + 1);
}

/** Body of a C# class (root-level `^}` closes it in both repos' style). */
function csClassBody(text, className) {
  const m = text.match(new RegExp(`(class|record) ${className}[^{]*`, ""));
  if (!m) return "";
  return sliceBalanced(text, text.indexOf("{", m.index + m[0].length - 1));
}

let failures = 0;
let notes = 0;
function check(section, missing, extras, exceptionMap = {}) {
  const realMissing = missing.filter((name) => {
    if (exceptionMap[name]) {
      console.log(`  ~ ${name} — EXCEPTED: ${exceptionMap[name]}`);
      notes++;
      return false;
    }
    return true;
  });
  for (const name of realMissing) {
    console.log(`  ✗ ${name} — present in C#, missing in TS`);
    failures++;
  }
  for (const name of extras) {
    console.log(`  + ${name} — TS-only (informational)`);
  }
  if (realMissing.length === 0) console.log("  ✓ in sync");
}

function compare(section, csNames, tsNames, mapCsToTs, exceptionMap) {
  console.log(`\n${section}:`);
  const tsSet = new Set(tsNames);
  const expected = csNames.map((n) => [n, mapCsToTs(n)]);
  const missing = expected.filter(([, ts]) => !tsSet.has(ts)).map(([cs]) => cs);
  const expectedTs = new Set(expected.map(([, ts]) => ts));
  const extras = tsNames.filter((n) => !expectedTs.has(n));
  check(section, missing, extras, exceptionMap);
}

// ─── 1. Ax25ParseOptions flags + presets ──────────────────────────────
const csParse = read(join(csRoot, "src/Packet.Core/Ax25ParseOptions.cs"));
const tsFrame = read(join(tsRoot, "src/frame.ts"));

// The extracted C# inventories are captured into named consts so the Rust
// leg (below) can reuse the SAME arrays — a single live C# source of truth
// feeding both the TS comparison and the pico-node coverage check.
const csParseFlags = csBoolProps(csParse);
compare(
  "Ax25ParseOptions flags",
  csParseFlags,
  tsInterfaceMembers(tsFrame, "Ax25ParseOptions"),
  camel,
  exceptions.parseOptionFlags ?? {},
);

const csParsePresets = csStaticPresets(csParse, "Ax25ParseOptions");
compare(
  "Ax25ParseOptions presets",
  csParsePresets,
  [...tsFrame.matchAll(/^export const (\w+)_PARSE\b/gm)].map((m) => `${m[1]}_PARSE`),
  (n) => `${n.toUpperCase()}_PARSE`,
  exceptions.parsePresets ?? {},
);

// ─── 2. Ax25SessionQuirks flags + presets ─────────────────────────────
const csQuirks = read(join(csRoot, "src/Packet.Ax25/Session/Ax25SessionQuirks.cs"));
const tsQuirks = read(join(tsRoot, "src/sdl/session-quirks.ts"));

const csQuirkFlags = csBoolProps(csQuirks);
compare(
  "Ax25SessionQuirks flags",
  csQuirkFlags,
  tsInterfaceMembers(tsQuirks, "Ax25SessionQuirks"),
  camel,
  exceptions.quirkFlags ?? {},
);

const csQuirkPresets = csStaticPresets(csQuirks, "Ax25SessionQuirks");
compare(
  "Ax25SessionQuirks presets",
  csQuirkPresets,
  [...tsQuirks.matchAll(/^export const (\w+)\s*:\s*Ax25SessionQuirks/gm)].map((m) => m[1]),
  (n) => `${camel(n)}SessionQuirks`,
  exceptions.quirkPresets ?? {},
);

// ─── 3. XidParseOptions flags ─────────────────────────────────────────
const csXid = read(join(csRoot, "src/Packet.Ax25/Xid/XidParseOptions.cs"));
const tsXid = read(join(tsRoot, "src/xid.ts"));

const csXidFlags = csBoolProps(csXid);
compare(
  "XidParseOptions flags",
  csXidFlags,
  tsInterfaceMembers(tsXid, "XidParseOptions"),
  camel,
  exceptions.xidFlags ?? {},
);

// ─── 4 + 5. Listener options + listener public surface ───────────────
const csListener = read(join(csRoot, "src/Packet.Ax25/Session/Ax25Listener.cs"));
const tsListener = read(join(tsRoot, "src/listener.ts"));

const csListenerOptionsBody = csClassBody(csListener, "Ax25ListenerOptions");
const csOptionNames = [
  ...csListenerOptionsBody.matchAll(/^\s*public [\w?<>. ]+? (\w+)\s*\{\s*get;/gm),
].map((m) => m[1]);

// C# option name → TS option name. Timer values are milliseconds-suffixed in
// TS (numbers, not TimeSpans) — an idiom difference, not drift.
const optionAlias = {
  MyCall: "myCall",
  T1V: "t1Ms",
  T2: "t2Ms",
  T3: "t3Ms",
  N2: "n2",
  K: "k",
  MaxCachedPeers: "maxCachedPeers",
  ParseOptions: "parseOptions",
  Quirks: "quirks",
  ConfigureSession: "configureSession",
};
compare(
  "Ax25ListenerOptions members",
  csOptionNames,
  tsInterfaceMembers(tsListener, "Ax25ListenerOptions"),
  (n) => optionAlias[n] ?? camel(n),
  exceptions.listenerOptions ?? {},
);

const csListenerBody = csClassBody(csListener, "Ax25Listener ");
const csSurface = [
  // public methods (Async suffix is a C# idiom — stripped by the alias map)
  ...[...csListenerBody.matchAll(/^\s{4}public (?:async )?[\w<>?. ]+? (\w+)\(/gm)].map((m) => m[1]),
  // public events
  ...[...csListenerBody.matchAll(/^\s{4}public event [\w<>?. ]+? (\w+);/gm)].map((m) => m[1]),
].filter((n) => n !== "Ax25Listener"); // constructors
const csListenerSurface = [...new Set(csSurface)];

const methodAlias = {
  StartAsync: "start",
  StopAsync: "stop",
  DisposeAsync: "dispose",
  ConnectAsync: "connect",
  SendUiAsync: "sendUi",
  SendTestAsync: "sendTest",
  SessionAccepted: "onSessionAccepted",
  FrameTraced: "onFrameTraced",
};
const tsListenerClassBody = sliceBalanced(
  tsListener,
  tsListener.indexOf("{", tsListener.indexOf("export class Ax25Listener ")),
);
const tsSurface = [
  ...tsListenerClassBody.matchAll(/^  (?:async )?(?:get )?(\w+)\s*[(<]/gm),
].map((m) => m[1]).filter((n) => n !== "constructor");

compare(
  "Ax25Listener public surface",
  csListenerSurface,
  [...new Set(tsSurface)],
  (n) => methodAlias[n] ?? camel(n),
  exceptions.listenerSurface ?? {},
);

// ─── 6. (optional) C# ⊆ Rust (pico-node) ──────────────────────────────
// The same live C# inventory, checked against pico-node's declared coverage.
// Section keys here MUST match parity/expected-inventory.json's `section`
// field and pico-node's own guard: parseOptionFlags, parsePresets, quirkFlags,
// quirkPresets, xidFlags, listenerOptions, listenerSurface.
if (rustRoot !== null) {
  rustLeg(rustRoot);
}

function rustLeg(root) {
  const manifestPath = join(root, "parity-manifest.toml");
  const inventoryPath = join(root, "parity", "expected-inventory.json");
  const exceptionsPath = join(root, "parity-exceptions.json");
  for (const [label, p] of [
    ["parity-manifest.toml", manifestPath],
    ["parity/expected-inventory.json", inventoryPath],
    ["parity-exceptions.json", exceptionsPath],
  ]) {
    if (!existsSync(p)) {
      console.error(
        `\nerror: --rust ${root} is missing ${label} (${p}). Point --rust at a ` +
          `pico-node checkout that carries its parity manifest, expected-inventory ` +
          `snapshot, and exceptions.`,
      );
      process.exit(2);
    }
  }

  const manifest = parseToml(read(manifestPath));
  const rustInventory = JSON.parse(read(inventoryPath));
  const rustExceptions = JSON.parse(read(exceptionsPath));

  const vectorSets = manifest.vector_sets ?? {};
  const inventoryExceptions = rustExceptions.inventoryExceptions ?? {};

  // Map (section → name → coverage) from pico-node's expected-inventory. This
  // is ONLY the coverage MAPPING; the item LIST comes from live C# above.
  const coverageOf = {};
  for (const item of rustInventory.items ?? []) {
    (coverageOf[item.section] ??= {})[item.name] = item.coverage ?? null;
  }

  // The live C# inventory, assembled from the SAME arrays the TS legs used.
  const liveInventory = [
    ...csParseFlags.map((name) => ["parseOptionFlags", name]),
    ...csParsePresets.map((name) => ["parsePresets", name]),
    ...csQuirkFlags.map((name) => ["quirkFlags", name]),
    ...csQuirkPresets.map((name) => ["quirkPresets", name]),
    ...csXidFlags.map((name) => ["xidFlags", name]),
    ...csOptionNames.map((name) => ["listenerOptions", name]),
    ...csListenerSurface.map((name) => ["listenerSurface", name]),
  ];

  console.log("\nC# ⊆ Rust (pico-node) coverage:");
  console.log(`  manifest:  ${manifestPath}`);
  console.log(`  inventory: ${inventoryPath}`);

  const rows = [];
  let covered = 0, excepted = 0, gaps = 0;
  for (const [section, name] of liveInventory) {
    // `coverage` may be: an object {set, capability?} (mapped), or absent from
    // expected-inventory entirely (undefined → treat as unmapped).
    const coverage =
      section in coverageOf && name in coverageOf[section] ? coverageOf[section][name] : undefined;
    const exceptionReason = inventoryExceptions[section]?.[name];

    let status, detail;
    if (coverage && coverage.set) {
      const set = vectorSets[coverage.set];
      if (!set) {
        status = "GAP"; detail = `coverage set '${coverage.set}' not in manifest`;
      } else if (set.in !== true) {
        status = "GAP"; detail = `coverage set '${coverage.set}' is declared-out (in=false)`;
      } else if (coverage.capability && !(set.capabilities ?? []).includes(coverage.capability)) {
        status = "GAP"; detail = `set '${coverage.set}' does not declare capability '${coverage.capability}'`;
      } else {
        status = "OK"; detail = `${coverage.set}${coverage.capability ? " / " + coverage.capability : ""}`;
      }
    } else if (exceptionReason) {
      status = "EXCEPT"; detail = exceptionReason;
    } else if (coverage === undefined) {
      status = "GAP"; detail = "not in pico-node expected-inventory and no exception (C# gained an item pico-node hasn't mapped)";
    } else {
      status = "GAP"; detail = "no coverage mapping and no exception";
    }

    // An item can be BOTH excepted and (accidentally) mapped — if mapping fails
    // but an exception exists, honour the exception rather than failing.
    if (status === "GAP" && exceptionReason) {
      status = "EXCEPT"; detail = exceptionReason;
    }

    if (status === "OK") covered++;
    else if (status === "EXCEPT") { excepted++; notes++; }
    else { gaps++; failures++; }
    rows.push({ status, section, name, detail });
  }

  const glyph = { OK: "✓", EXCEPT: "~", GAP: "✗" };
  let lastSection = "";
  for (const r of rows) {
    if (r.section !== lastSection) { console.log(""); lastSection = r.section; }
    const detail = r.status === "EXCEPT" && r.detail.length > 68 ? r.detail.slice(0, 65) + "..." : r.detail;
    console.log(`  ${glyph[r.status]} ${r.section}.${r.name} — ${detail}`);
  }
  console.log(
    `\n  ${gaps === 0 ? "✓" : "✗"} pico-node coverage: ${covered} covered, ${excepted} excepted, ${gaps} gap(s)`,
  );
}

// ─── minimal TOML reader (for the optional Rust leg) ──────────────────
// Enough for pico-node's parity-manifest.toml: top-level scalars, [a.b.c]
// tables, and key = <bool | int | "string" | ["a", "b"]>. No external
// dependency, matching this script's node:builtins-only posture and mirroring
// pico-node's own scripts/parity-check.mjs reader.
function stripComment(line) {
  let inStr = false, q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}
function splitTopLevel(s) {
  const out = [];
  let cur = "", inStr = false, q = "";
  for (const c of s) {
    if (inStr) { cur += c; if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; cur += c; continue; }
    if (c === ",") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseValue(s) {
  s = s.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[")) {
    const inner = s.slice(1, s.lastIndexOf("]"));
    return inner.trim() ? splitTopLevel(inner).map(parseValue) : [];
  }
  return s; // bare fallback
}
function parseToml(text) {
  const root = {};
  let current = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const name = line.slice(1, line.indexOf("]")).trim();
      const parts = name.split(".").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      current = root;
      for (const p of parts) {
        if (typeof current[p] !== "object" || current[p] === null) current[p] = {};
        current = current[p];
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    current[key] = parseValue(line.slice(eq + 1));
  }
  return root;
}

// ─── verdict ──────────────────────────────────────────────────────────
console.log("");
if (failures > 0) {
  console.log(
    `PARITY DRIFT: ${failures} gap(s). Either add the TS counterpart, or record ` +
      `a reviewed exception (with a reason) in scripts/parity-exceptions.json.` +
      (rustRoot !== null
        ? " For a Rust-leg gap, map the C# item to an opted-in vector_set in " +
          "pico-node's parity-manifest.toml (+ parity/expected-inventory.json), or " +
          "record a reviewed exception in its parity-exceptions.json."
        : ""),
  );
  process.exit(1);
}
console.log(
  `Parity check passed${notes > 0 ? ` (${notes} documented exception(s))` : ""}.`,
);
