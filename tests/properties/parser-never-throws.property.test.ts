/**
 * Property: the parsers degrade *cleanly* on arbitrary / adversarial input —
 * the TS analogue of packet.net's AFL-style fuzzer (`tools/Packet.Fuzz`,
 * `m0lte/packet.net`), which the TS side previously lacked entirely.
 *
 *  - {@link decodeFrame}: by design throws on malformed input (its doc comment
 *    says "call inside try/catch"). The property is that the failure is always
 *    *clean* — a plain {@link Error} — and never a pathological crash
 *    (`RangeError`/`TypeError` from an out-of-bounds read, a non-Error throw, a
 *    hang). On the inputs it *accepts*, it must return a structurally well-formed
 *    {@link Ax25Frame} (digipeater count within bounds, `info` a `Uint8Array`,
 *    the parsed length self-consistent). A garbage-in → corrupt-frame-out would
 *    fail the structural check.
 *  - {@link KissDecoder}: documented as lenient — it must *never* throw on any
 *    byte stream, and every frame it yields has an in-range port/command nibble
 *    and a `Uint8Array` payload. It must also be chunk-boundary-invariant:
 *    splitting the same byte stream into different chunk sizes yields the same
 *    decoded frames (the stateful escape/FEND handling can't depend on where the
 *    reads land).
 *
 * Inputs mix pure-uniform-random bytes (which almost always trip the
 * address-chain checks → the throw path) with *mutated real frames* (encode a
 * valid frame, then flip/truncate/extend bytes → far more likely to reach the
 * accept path and the lenient trailing-byte branches), so both the reject and
 * the accept paths get swept.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type Ax25Frame,
  MAX_DIGIPEATERS,
  decodeFrame,
  encodeFrame,
  requiredBytes,
} from "../../src/frame.js";
import { KissDecoder, encodeKiss } from "../../src/kiss.js";
import {
  NETROM_PARSE_LENIENT,
  NETROM_PARSE_STRICT,
  NODES_MAX_ENTRIES_PER_FRAME,
  NODES_SIGNATURE,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { frameArb } from "./arbitraries.js";

const RUNS = 3000;

/** Arbitrary raw bytes: 0..80 octets of anything. */
const rawBytesArb = fc.uint8Array({ minLength: 0, maxLength: 80 });

/** A valid frame's wire bytes, then mutated: a mix of byte flips, a truncation,
 * and trailing-garbage extension — biased to land near (but off) the valid-frame
 * manifold, exercising the parser's accept path and lenient branches. */
const mutatedFrameBytesArb: fc.Arbitrary<Uint8Array> = fc
  .record({
    extended: fc.boolean(),
    frame: fc.oneof(frameArb(false), frameArb(true)),
    flips: fc.array(fc.nat(), { minLength: 0, maxLength: 6 }),
    truncateTo: fc.option(fc.nat(), { nil: undefined }),
    extra: fc.uint8Array({ minLength: 0, maxLength: 8 }),
  })
  .map(({ frame, flips, truncateTo, extra }) => {
    let bytes = Array.from(encodeFrame(frame));
    for (const f of flips) {
      if (bytes.length > 0) {
        const idx = f % bytes.length;
        bytes[idx] = bytes[idx]! ^ 0xff;
      }
    }
    if (truncateTo !== undefined && bytes.length > 0) {
      bytes = bytes.slice(0, truncateTo % (bytes.length + 1));
    }
    bytes = bytes.concat(Array.from(extra));
    return Uint8Array.from(bytes);
  });

/** A structurally well-formed decoded frame (the accept-path invariant). */
function assertWellFormed(f: Ax25Frame, bytes: Uint8Array, extended: boolean): void {
  expect(f.info).toBeInstanceOf(Uint8Array);
  expect(f.digipeaters.length).toBeLessThanOrEqual(MAX_DIGIPEATERS);
  // The decoder consumed a self-consistent slice: re-deriving the wire length
  // from the parsed structure can't exceed the bytes it was handed.
  expect(requiredBytes(f)).toBeLessThanOrEqual(bytes.length);
  // controlExtension only exists for extended I/S frames (never under mod-8).
  if (!extended) expect(f.controlExtension).toBeNull();
}

/** decodeFrame must either return a well-formed frame or throw a *plain* Error
 * (never a RangeError/TypeError/non-Error — those would signal an internal
 * bug). */
function decodeIsClean(bytes: Uint8Array, extended: boolean): void {
  try {
    const f = decodeFrame(bytes, extended);
    assertWellFormed(f, bytes, extended);
  } catch (e) {
    // A clean parse failure is a plain Error. Anything else (RangeError from an
    // out-of-bounds index, a TypeError, a thrown string) is a real defect.
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).constructor).toBe(Error);
  }
}

describe("property: decodeFrame degrades cleanly (clean throw or well-formed frame)", () => {
  for (const extended of [false, true]) {
    const modLabel = extended ? "mod-128" : "mod-8";
    it(`on pure-random bytes [${modLabel}]`, () => {
      fc.assert(
        fc.property(rawBytesArb, (bytes) => decodeIsClean(bytes, extended)),
        { numRuns: RUNS },
      );
    });
    it(`on mutated real frames [${modLabel}]`, () => {
      fc.assert(
        fc.property(mutatedFrameBytesArb, (bytes) => decodeIsClean(bytes, extended)),
        { numRuns: RUNS },
      );
    });
  }
});

describe("property: KissDecoder never throws and yields well-formed frames", () => {
  it("on arbitrary byte chunks", () => {
    fc.assert(
      fc.property(
        fc.array(rawBytesArb, { minLength: 0, maxLength: 8 }),
        (chunks) => {
          const dec = new KissDecoder();
          for (const chunk of chunks) {
            const frames = dec.push(chunk);
            for (const f of frames) {
              expect(f.port).toBeGreaterThanOrEqual(0);
              expect(f.port).toBeLessThanOrEqual(15);
              expect(f.command).toBeGreaterThanOrEqual(0);
              expect(f.command).toBeLessThanOrEqual(15);
              expect(f.payload).toBeInstanceOf(Uint8Array);
            }
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Chunk-boundary invariance: the same byte stream decoded in one push vs split
  // at arbitrary points yields identical frames. The stateful escape/FEND
  // machinery must not depend on where the reads land.
  it("is invariant to where the stream is chunked", () => {
    fc.assert(
      fc.property(
        rawBytesArb,
        fc.array(fc.nat(), { minLength: 0, maxLength: 6 }),
        (stream, rawCuts) => {
          const whole = collect(stream, [stream.length]);
          const cuts = rawCuts
            .map((c) => (stream.length === 0 ? 0 : c % (stream.length + 1)))
            .sort((a, b) => a - b);
          const split = collect(stream, [...cuts, stream.length]);
          expect(framesToPlain(split)).toEqual(framesToPlain(whole));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

/** Decode `stream` feeding it in slices delimited by the (sorted) `boundaries`
 * (each an absolute offset; the final one should be `stream.length`). */
function collect(stream: Uint8Array, boundaries: number[]): ReturnType<KissDecoder["push"]> {
  const dec = new KissDecoder();
  const out: ReturnType<KissDecoder["push"]> = [];
  let prev = 0;
  for (const b of boundaries) {
    out.push(...dec.push(stream.subarray(prev, b)));
    prev = b;
  }
  return out;
}

function framesToPlain(
  frames: ReturnType<KissDecoder["push"]>,
): { port: number; command: number; payload: number[] }[] {
  return frames.map((f) => ({
    port: f.port,
    command: f.command,
    payload: Array.from(f.payload),
  }));
}

// Sanity: a *valid* KISS-wrapped frame always decodes back to its payload — the
// fuzz property's positive control (so "never throws" isn't trivially satisfied
// by "decodes nothing"). KISS escapes the command byte too, so the command
// nibble survives even when port<<4|cmd collides with FEND/FESC.
describe("property: well-formed KISS frames always round-trip", () => {
  it("encodeKiss → KissDecoder recovers port, command, payload", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        fc.uint8Array({ minLength: 0, maxLength: 64 }),
        (port, command, payload) => {
          const wire = encodeKiss(port, command, payload);
          const dec = new KissDecoder();
          const frames = dec.push(wire);
          expect(frames.length).toBe(1);
          expect(frames[0]!.port).toBe(port);
          expect(frames[0]!.command).toBe(command);
          expect(Array.from(frames[0]!.payload)).toEqual(Array.from(payload));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// NET/ROM NODES-broadcast parser totality — the TS analogue of the C#
// `NodesBroadcastParseTests` random-garbage + short-input totality cases, lifted
// into the property suite. parseNodesBroadcast is *read-only ingest of
// third-party broadcasts*, so it must NEVER throw on any byte sequence (it
// returns null on malformed input), and any broadcast it *does* accept must be
// structurally well-formed under both presets.
describe("property: parseNodesBroadcast never throws and yields well-formed broadcasts", () => {
  /** Bytes that often *look* like a NODES info field: a 0xFF signature, a
   * 6-byte alias region, then a run of near-21-byte entries, plus stray
   * trailing bytes — biased to reach the entry-parse + trailing-remainder
   * branches rather than bouncing off the signature gate. */
  const nodesLikeBytesArb: fc.Arbitrary<Uint8Array> = fc
    .record({
      sig: fc.constantFrom(NODES_SIGNATURE, 0x00, 0xfe),
      alias: fc.uint8Array({ minLength: 0, maxLength: 6 }),
      body: fc.uint8Array({ minLength: 0, maxLength: 21 * 14 }),
    })
    .map(({ sig, alias, body }) => Uint8Array.from([sig, ...alias, ...body]));

  for (const [label, arb] of [
    ["pure-random bytes", rawBytesArb],
    ["NODES-shaped bytes", nodesLikeBytesArb],
  ] as const) {
    for (const [presetLabel, options] of [
      ["lenient", NETROM_PARSE_LENIENT],
      ["strict", NETROM_PARSE_STRICT],
    ] as const) {
      it(`on ${label} [${presetLabel}]`, () => {
        fc.assert(
          fc.property(arb, (bytes) => {
            const bc = parseNodesBroadcast(bytes, options);
            if (bc === null) return; // a clean rejection is fine
            // Accept path invariants.
            expect(typeof bc.senderAlias).toBe("string");
            expect(bc.entries.length).toBeLessThanOrEqual(NODES_MAX_ENTRIES_PER_FRAME);
            for (const e of bc.entries) {
              expect(typeof e.destinationAlias).toBe("string");
              expect(e.bestQuality).toBeGreaterThanOrEqual(0);
              expect(e.bestQuality).toBeLessThanOrEqual(255);
            }
          }),
          { numRuns: RUNS },
        );
      });
    }
  }
});
