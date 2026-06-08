import { Callsign } from "../callsign.js";
import { DEFAULT_TIME_TO_LIVE } from "./network-header.js";
import { NetRomTransportFlags, OPCODE_MASK } from "./transport-header.js";
import {
  encodeNetRomPacket,
  type NetRomPacket,
  tryParseNetRomPacket,
} from "./packet.js";
import { INP3_DEFAULT_CAPABILITY_TEXT_WIDTH } from "./inp3-options.js";

/**
 * The INP3 `L3RTT` link-time-measurement frame — an *ordinary* L3 info datagram,
 * not a new frame family. It is a {@link NetRomPacket} whose destination node
 * callsign is the literal `L3RTT-0`, whose transport opcode nibble is `0x02`,
 * and whose payload is space-padded ASCII carrying the INP3 capability flags
 * (`$N` = "I speak INP3", `$IX` = "I accept IP version X"). The neighbour
 * reflects the frame back verbatim; the originator times the round trip (RTT ÷ 2
 * → SNTT) — that timing is a later slice; this type is the codec only: a thin
 * **builder + recogniser** over {@link NetRomPacket}, reusing
 * `NetRomNetworkHeader` (15 B) and `NetRomTransportHeader` (5 B) unchanged.
 *
 * Layout (a {@link NetRomPacket}, so it rides PID 0xCF like every L3 datagram):
 * ```
 *   [15] NetRomNetworkHeader    origin = us; destination = LITERAL "L3RTT-0"; TTL = default (25)
 *   [ 5] NetRomTransportHeader  opcode nibble = 0x02 (ConnectAcknowledge's value, but disambiguated by the dest)
 *   [ N] payload                space-padded ASCII capability text ($N then optional $IX, right-padded)
 * ```
 *
 * The opcode value `0x02` collides numerically with `NetRomOpcode.ConnectAcknowledge`;
 * an L3RTT frame is disambiguated by its **destination = `L3RTT-0`**, never by
 * opcode alone — see {@link Inp3L3RttFrame.isL3Rtt}. A frame is recognised as
 * *our own* reflection (vs. a peer's probe we must reflect) when its origin
 * equals our node callsign, because reflection is byte-for-byte echo (origin
 * stays the original prober).
 *
 * Parsing is total: arbitrary, truncated, or adversarial bytes return `null`,
 * never throw. The capability text is parsed by a width-independent `$`-token
 * scan, so the emitted pad width ({@link Inp3L3RttFrame.DefaultCapabilityTextWidth})
 * is a cosmetic choice, not something the recogniser depends on — unknown
 * `$`-tokens are ignored (forward-compat). See `docs/netrom-inp3-i1-wire-spec.md`
 * §1 and AMBIGUITY-L3RTT-{1,2,3,4}.
 *
 * Mirrors `Packet.NetRom.Wire.Inp3L3RttFrame` on the C# side. Modelled as a class
 * (static factory + recogniser, instance `toBytes` / `isReflectionOf`) rather
 * than free functions, to mirror the C# record's static-method shape and because
 * the {@link Inp3Engine} consumer keys on `frame instanceof Inp3L3RttFrame` and
 * calls `Inp3L3RttFrame.build` / `.tryFrom` statically.
 */
export class Inp3L3RttFrame {
  /** The literal base callsign every L3RTT datagram is destined to. */
  static readonly L3RttBase = "L3RTT";

  /** The canonical SSID of the L3RTT destination (always 0). */
  static readonly L3RttSsid = 0;

  /**
   * The transport opcode nibble that marks an L3RTT datagram (0x02). Numerically
   * equal to `NetRomOpcode.ConnectAcknowledge`; the destination callsign — not
   * this value — is what disambiguates an L3RTT frame from a Connect Acknowledge.
   */
  static readonly L3RttOpcode = 0x02;

  /**
   * The `$N` capability token — "I speak INP3". Its presence anywhere in the
   * trimmed payload is how a node advertises INP3 capability; its absence means
   * fall back to vanilla NODES.
   */
  static readonly CapabilityInp3 = "$N";

  /**
   * The `$I` prefix of the IP-accept token (`$IX`, where X is the IP version
   * digit, e.g. `$I4` for IPv4).
   */
  static readonly CapabilityIpPrefix = "$I";

  /**
   * The emitted capability-text field width: `$N` (+ optional `$IX`) right-padded
   * with ASCII spaces to this many octets. The INP3 PDF does not fix the width
   * (AMBIGUITY-L3RTT-3) — the recogniser is width-independent, so this is purely
   * an emit-side default to be calibrated against a live peer in a later slice.
   *
   * Aliases the one existing source of truth in `inp3-options.ts`
   * ({@link INP3_DEFAULT_CAPABILITY_TEXT_WIDTH}) so there is a single `8` shared by
   * the codec and the link-timing options.
   */
  static readonly DefaultCapabilityTextWidth = INP3_DEFAULT_CAPABILITY_TEXT_WIDTH;

  /** The {@link NetRomPacket} that *is* this L3RTT frame. */
  readonly packet: NetRomPacket;

  /** Whether the trimmed payload carried the `$N` token — i.e. the far end
   *  advertised INP3 capability. */
  readonly inp3Capable: boolean;

  /** The IP version the far end accepts (the digit from a `$IX` token, e.g. 4 for
   *  IPv4), or `null` if no `$IX` token was present. */
  readonly ipAccept: number | null;

  /** The raw, untrimmed capability-text payload as it appeared on the wire (the
   *  bytes after the 20-octet L3+L4 header, decoded as ASCII). */
  readonly capabilityText: string;

  private constructor(
    packet: NetRomPacket,
    inp3Capable: boolean,
    ipAccept: number | null,
    capabilityText: string,
  ) {
    this.packet = packet;
    this.inp3Capable = inp3Capable;
    this.ipAccept = ipAccept;
    this.capabilityText = capabilityText;
  }

  /**
   * Build an L3RTT probe datagram: a {@link NetRomPacket} to `L3RTT-0` with opcode
   * nibble 0x02 and a space-padded capability text payload (`$N`, then an optional
   * `$IX`, right-padded to `capabilityTextWidth`). Strict, like every encoder
   * here: it never emits a malformed frame.
   *
   * Mirrors `Inp3L3RttFrame.Build` on the C# side (the C# optional parameters
   * become positional optional args here, each `undefined` falling back to the
   * default).
   *
   * @param origin The probing node's own callsign (the frame's L3 origin).
   * @param ipAccept If set (e.g. 4), append a `$IX` token advertising the accepted
   *   IP version. Must be a single decimal digit 0–9.
   * @param timeToLive The L3 TTL. Defaults to the node's normal initial TTL
   *   ({@link DEFAULT_TIME_TO_LIVE}); any value ≥ 1 works for this single-hop
   *   neighbour probe.
   * @param capabilityTextWidth The total octet width to right-pad the capability
   *   text to (default {@link Inp3L3RttFrame.DefaultCapabilityTextWidth}). If the
   *   tokens are longer than this, no padding is added (tokens are never
   *   truncated).
   * @throws If `ipAccept` is not a single decimal digit 0–9, or
   *   `capabilityTextWidth` is negative.
   */
  static build(
    origin: Callsign,
    ipAccept?: number,
    timeToLive: number = DEFAULT_TIME_TO_LIVE,
    capabilityTextWidth: number = Inp3L3RttFrame.DefaultCapabilityTextWidth,
  ): Inp3L3RttFrame {
    const ip = ipAccept ?? null;
    if (ip !== null && (ip < 0 || ip > 9)) {
      throw new Error(
        `IP-accept version must be a single decimal digit 0–9 (got ${ip})`,
      );
    }
    if (capabilityTextWidth < 0) {
      throw new Error(
        `capability text width must be non-negative (got ${capabilityTextWidth})`,
      );
    }

    let text =
      Inp3L3RttFrame.CapabilityInp3 +
      (ip !== null
        ? Inp3L3RttFrame.CapabilityIpPrefix + String.fromCharCode(0x30 + ip)
        : "");
    if (text.length < capabilityTextWidth) {
      text = text.padEnd(capabilityTextWidth, " ");
    }

    const packet: NetRomPacket = {
      network: {
        origin,
        destination: new Callsign(
          Inp3L3RttFrame.L3RttBase,
          Inp3L3RttFrame.L3RttSsid,
        ),
        timeToLive,
      },
      transport: {
        circuitIndex: 0,
        circuitId: 0,
        txSequence: 0,
        rxSequence: 0,
        opcode: Inp3L3RttFrame.L3RttOpcode,
        flags: NetRomTransportFlags.None,
      },
      // ASCII-only by construction ($N / $IX / spaces), so a per-char cast is exact.
      payload: asciiBytes(text),
    };

    return new Inp3L3RttFrame(packet, true, ip, text);
  }

  /**
   * Allocate and return the full L3RTT datagram bytes (the I-frame information
   * field to send with PID 0xCF) — just {@link encodeNetRomPacket} of the wrapped
   * packet.
   *
   * Mirrors `Inp3L3RttFrame.ToBytes` on the C# side.
   */
  toBytes(): Uint8Array {
    return encodeNetRomPacket(this.packet);
  }

  /**
   * Whether an already-parsed {@link NetRomPacket} is an L3RTT frame: its
   * destination decodes to base `L3RTT` (SSID ignored for the match) and its
   * transport opcode nibble is `0x02`. The destination test comes first — opcode
   * 0x02 alone is also `NetRomOpcode.ConnectAcknowledge`.
   *
   * Mirrors `Inp3L3RttFrame.IsL3Rtt` on the C# side.
   */
  static isL3Rtt(packet: NetRomPacket): boolean {
    return (
      packet.network.destination.base === Inp3L3RttFrame.L3RttBase &&
      (packet.transport.opcode & OPCODE_MASK) === Inp3L3RttFrame.L3RttOpcode
    );
  }

  /**
   * Try to recognise and decode an L3RTT frame from an interlink I-frame's
   * information field. Returns `null` (never throws) if the bytes are not a
   * well-formed {@link NetRomPacket}, or are a packet that is not L3RTT (wrong
   * destination or opcode). On success the capability flags
   * (`$N` → {@link Inp3L3RttFrame.inp3Capable}, `$IX` →
   * {@link Inp3L3RttFrame.ipAccept}) are extracted by a width-independent token
   * scan of the payload.
   *
   * Mirrors `Inp3L3RttFrame.TryParse` on the C# side.
   */
  static tryParse(info: Uint8Array): Inp3L3RttFrame | null {
    const packet = tryParseNetRomPacket(info);
    if (packet === null) {
      return null;
    }
    return Inp3L3RttFrame.tryFrom(packet);
  }

  /**
   * Try to recognise an already-parsed {@link NetRomPacket} as an L3RTT frame and
   * extract its capability flags. Returns `null` (never throws) if the packet is
   * not L3RTT. Useful when the caller already decoded the datagram on a shared
   * receive path and only wants to classify it.
   *
   * Mirrors `Inp3L3RttFrame.TryFrom` on the C# side.
   */
  static tryFrom(packet: NetRomPacket): Inp3L3RttFrame | null {
    if (!Inp3L3RttFrame.isL3Rtt(packet)) {
      return null;
    }

    const text = asciiString(packet.payload);
    const { inp3Capable, ipAccept } = scanCapabilities(text);
    return new Inp3L3RttFrame(packet, inp3Capable, ipAccept, text);
  }

  /**
   * Whether this frame is a reflection of *our own* probe (vs. a peer's probe we
   * are expected to reflect): reflection is verbatim echo, so the origin of a
   * returning frame is unchanged — it equals our node callsign.
   *
   * Mirrors `Inp3L3RttFrame.IsReflectionOf` on the C# side.
   *
   * @param ourNodeCallsign This node's own L3 callsign.
   */
  isReflectionOf(ourNodeCallsign: Callsign): boolean {
    return this.packet.network.origin.equals(ourNodeCallsign);
  }
}

/**
 * Scan a capability text for the `$`-prefixed tokens. Width-independent and
 * total — it never throws. `$N` sets `inp3Capable`; a `$IX` with a single decimal
 * digit X sets `ipAccept` (only the first such token wins). Unknown `$`-tokens are
 * ignored (forward-compat).
 *
 * Mirrors `Inp3L3RttFrame.ScanCapabilities` on the C# side.
 */
function scanCapabilities(text: string): {
  inp3Capable: boolean;
  ipAccept: number | null;
} {
  let inp3Capable = false;
  let ipAccept: number | null = null;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$") {
      continue;
    }

    // Token = '$' + the following character. We classify by the first character
    // after the '$'.
    const t = i + 1;
    if (t >= text.length) {
      break;
    }

    const kind = text[t]!;
    if (kind === "N") {
      inp3Capable = true;
    } else if (
      kind === "I" &&
      t + 1 < text.length &&
      isAsciiDigit(text[t + 1]!) &&
      ipAccept === null
    ) {
      ipAccept = text.charCodeAt(t + 1) - 0x30;
    }
    // Any other '$'-token (unknown capability) is silently ignored.
  }

  return { inp3Capable, ipAccept };
}

/** True if `c` is a single ASCII decimal digit 0–9. */
function isAsciiDigit(c: string): boolean {
  const code = c.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

/**
 * Encode an ASCII-only string to bytes (one byte per char, low 7 bits). Used only
 * for the capability text the builder constructs, which is guaranteed ASCII
 * (`$N` / `$IX` / spaces).
 *
 * Mirrors `Inp3L3RttFrame.AsciiBytes` on the C# side.
 */
function asciiBytes(text: string): Uint8Array {
  const buf = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    buf[i] = text.charCodeAt(i) & 0x7f;
  }
  return buf;
}

/**
 * Decode wire bytes to a string for token scanning, one char per byte
 * (Latin-1-ish). Non-ASCII / high-bit octets become the corresponding char but
 * never affect the `$`-token scan — they are not `$`, `N`, or a digit. Total: any
 * bytes decode without throwing.
 *
 * Mirrors `Inp3L3RttFrame.AsciiString` on the C# side.
 */
function asciiString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}
