import { Callsign } from "./callsign.js";
import {
  ADDRESS_ENCODED_LENGTH,
  type Ax25Address,
  readAddress,
  writeAddress,
} from "./address.js";

/** PID 0xF0 — no Layer 3 protocol implemented (AX.25 v2.2 §3.4). */
export const PID_NO_LAYER_3 = 0xf0;

/** PID 0xCF — NET/ROM. */
export const PID_NET_ROM = 0xcf;

/** Maximum digipeater chain length (§3.12.5). */
export const MAX_DIGIPEATERS = 8;

/**
 * P/F bit position in the *first* control octet — the mod-8 / U-frame P/F
 * location (bit 4). Under extended (mod-128) modulo, an I/S frame's P/F bit
 * migrates to bit 0 of the second control octet (see {@link CONTROL_EXT_PF_BIT}
 * and Fig 4.1b); U frames keep bit 4 of their single octet in both modes.
 */
const CONTROL_PF_BIT = 0x10;

/**
 * P/F bit position in the *second* control octet of an extended (mod-128) I/S
 * frame: bit 0 (Fig 4.1b — `(N(R) << 1) | P/F`). NOT bit 4.
 */
const CONTROL_EXT_PF_BIT = 0x01;

// U-frame control-byte bases (§4.3.3, P/F masked off).
const CONTROL_SABM = 0x2f;
const CONTROL_SABME = 0x6f;
const CONTROL_DISC = 0x43;
const CONTROL_UA = 0x63;
const CONTROL_DM = 0x0f;
const CONTROL_UI = 0x03;
const CONTROL_FRMR = 0x87; // Frame Reject (§4.3.3.9) — response only.
const CONTROL_XID = 0xaf; // Exchange Identification (§4.3.3.7) — command or response.

// S-frame control-byte bases (§4.3.2).
const CONTROL_RR = 0x01;
const CONTROL_RNR = 0x05;
const CONTROL_REJ = 0x09;
const CONTROL_SREJ = 0x0d;

/**
 * The high-level frame kind, after classification of the (first) control
 * octet. Modulo-independent: the I/S/U discriminator and the S-frame subtype
 * live in the first octet, which is identical under mod-8 and extended mod-128
 * (Fig 4.1a/4.1b), so {@link classify} reads only that octet and is correct in
 * both modulos. The 7-bit N(R)/N(S) that *do* differ by modulo are decoded
 * mode-aware via {@link getNr} / {@link getNs}.
 */
export type FrameKind =
  | "SABM"
  | "SABME"
  | "DISC"
  | "UA"
  | "DM"
  | "UI"
  | "RR"
  | "RNR"
  | "REJ"
  | "SREJ"
  | "I"
  | "FRMR"
  | "XID"
  | "UNKNOWN";

/**
 * One AX.25 frame as delivered by KISS — no opening / closing flag,
 * no FCS (the TNC handles HDLC framing and the FCS).
 *
 * Layout per AX.25 v2.2 §3:
 *   [destination 7B] [source 7B] [digipeaters 0..8 × 7B] [control 1..2B]
 *   [pid 0..1B] [info 0..N B]
 *
 * The control field is 1 octet for U frames and for every mod-8 frame, and
 * 2 octets for an extended (mod-128) I or S frame (Fig 4.1b). PID and info are
 * present only on I and UI frames.
 */
export interface Ax25Frame {
  destination: Ax25Address;
  source: Ax25Address;
  digipeaters: readonly Ax25Address[];
  /**
   * Raw control byte — the first (low-order) control octet. For an extended
   * (mod-128) I or S frame this is the first of two octets;
   * {@link Ax25Frame.controlExtension} holds the second. The frame-type
   * discriminator bits live here in both modulos, so {@link classify} reads
   * this octet regardless of modulo.
   */
  control: number;
  /**
   * Second control octet of an extended (mod-128) I or S frame, carrying the
   * 7-bit N(R) (bits 7-1) and the P/F bit (bit 0) per Fig 4.1b. `null` for
   * U frames and for every mod-8 frame — those have a 1-octet control field.
   * Its presence is what makes a frame "extended" (see
   * {@link isExtendedControl}).
   */
  controlExtension: number | null;
  /** PID byte, present on I/UI frames only. */
  pid: number | null;
  /** Information field. Always present (zero-length if absent). */
  info: Uint8Array;
}

/**
 * True when this frame carries the 2-octet (mod-128) control field —
 * equivalent to {@link Ax25Frame.controlExtension} being present.
 */
export function isExtendedControl(frame: Ax25Frame): boolean {
  return frame.controlExtension !== null;
}

/** True if address C-bits encode a command per §6.1.2 (dest C=1, src C=0). */
export function isCommand(frame: Ax25Frame): boolean {
  return frame.destination.crhBit && !frame.source.crhBit;
}

/** True if address C-bits encode a response per §6.1.2 (dest C=0, src C=1). */
export function isResponse(frame: Ax25Frame): boolean {
  return !frame.destination.crhBit && frame.source.crhBit;
}

/**
 * True if the P/F bit is set. In a mod-8 frame (and any U frame, which is
 * 1 octet in both modes) the P/F bit is bit 4 of the control octet; in an
 * extended (mod-128) I or S frame it migrates to bit 0 of the second control
 * octet (Fig 4.1b).
 */
export function pollFinal(frame: Ax25Frame): boolean {
  if (frame.controlExtension !== null) {
    return (frame.controlExtension & CONTROL_EXT_PF_BIT) !== 0;
  }
  return (frame.control & CONTROL_PF_BIT) !== 0;
}

/** Classify the control byte into a high-level frame kind. */
export function classify(frame: Ax25Frame): FrameKind {
  const ctrl = frame.control;
  if ((ctrl & 0x01) === 0) return "I";
  if ((ctrl & 0x03) === 0x01) {
    switch (ctrl & 0x0c) {
      case 0x00:
        return "RR";
      case 0x04:
        return "RNR";
      case 0x08:
        return "REJ";
      default:
        return "SREJ"; // ctrl & 0x0c === 0x0c — Selective Reject (§4.3.2.4).
    }
  }
  const uBase = ctrl & 0xef;
  switch (uBase) {
    case CONTROL_SABM:
      return "SABM";
    case CONTROL_SABME:
      return "SABME";
    case CONTROL_DISC:
      return "DISC";
    case CONTROL_UA:
      return "UA";
    case CONTROL_DM:
      return "DM";
    case CONTROL_UI:
      return "UI";
    case CONTROL_FRMR:
      return "FRMR";
    case CONTROL_XID:
      return "XID";
    default:
      return "UNKNOWN";
  }
}

/**
 * N(S), the send sequence number carried by I frames. 3-bit in mod-8 (control
 * bits 3-1); 7-bit in extended mod-128 (first control octet bits 7-1) per
 * Fig 4.1b. Meaningful only for I frames — on an S frame the same bits encode
 * the supervisory type, so the caller must check the frame type first.
 */
export function getNs(frame: Ax25Frame): number {
  if (frame.controlExtension !== null) {
    return (frame.control >> 1) & 0x7f;
  }
  return (frame.control >> 1) & 0x07;
}

/**
 * N(R), the receive sequence number carried by I and S frames. 3-bit in mod-8
 * (control bits 7-5); 7-bit in extended mod-128 (second control octet bits 7-1)
 * per Fig 4.1b. Meaningless on U frames — the caller must know the frame type
 * before relying on this.
 */
export function getNr(frame: Ax25Frame): number {
  if (frame.controlExtension !== null) {
    return (frame.controlExtension >> 1) & 0x7f;
  }
  return (frame.control >> 5) & 0x07;
}

/** Compute total wire length the encoder will produce for this frame. */
export function requiredBytes(frame: Ax25Frame): number {
  return (
    ADDRESS_ENCODED_LENGTH + // destination
    ADDRESS_ENCODED_LENGTH + // source
    frame.digipeaters.length * ADDRESS_ENCODED_LENGTH +
    1 + // control (first octet)
    (frame.controlExtension === null ? 0 : 1) + // extended control (mod-128 I/S)
    (frame.pid === null ? 0 : 1) +
    frame.info.length
  );
}

/** Encode an Ax25Frame into a flat Uint8Array (no KISS framing). */
export function encodeFrame(frame: Ax25Frame): Uint8Array {
  const buf = new Uint8Array(requiredBytes(frame));
  let offset = 0;
  writeAddress(buf, offset, frame.destination);
  offset += ADDRESS_ENCODED_LENGTH;
  writeAddress(buf, offset, frame.source);
  offset += ADDRESS_ENCODED_LENGTH;
  for (const digi of frame.digipeaters) {
    writeAddress(buf, offset, digi);
    offset += ADDRESS_ENCODED_LENGTH;
  }
  buf[offset++] = frame.control & 0xff;
  // Extended (mod-128) I/S frames have a 2-octet control field, transmitted
  // first octet first (Fig 4.1b: bit 0 of the first octet is the first bit
  // sent). `control` is the first octet; `controlExtension` the second.
  if (frame.controlExtension !== null) {
    buf[offset++] = frame.controlExtension & 0xff;
  }
  if (frame.pid !== null) {
    buf[offset++] = frame.pid & 0xff;
  }
  buf.set(frame.info, offset);
  return buf;
}

/**
 * Decode an Ax25Frame from KISS-form bytes (no flag, no FCS). Throws on
 * malformed input — call inside try/catch when feeding raw KISS payloads.
 *
 * `extended` selects the link's negotiated modulo. An I or S frame's control
 * field is 1 octet under mod-8 and 2 octets under mod-128 (Fig 4.1b), and the
 * width is *not* derivable from the octets alone — so the caller (the receive
 * path, which knows the session's modulo) passes it. U frames are 1 octet in
 * both modes, so `extended` only affects I and S frames. Defaults to mod-8;
 * the addresses precede the control field and are modulo-independent, so a
 * mod-8 decode is always valid for routing.
 */
export function decodeFrame(bytes: Uint8Array, extended = false): Ax25Frame {
  if (bytes.length < 2 * ADDRESS_ENCODED_LENGTH + 1) {
    throw new Error(`frame too short: ${bytes.length} bytes`);
  }
  let offset = 0;
  const destination = readAddress(bytes, offset);
  offset += ADDRESS_ENCODED_LENGTH;
  if (destination.extensionBit) {
    throw new Error("E-bit set on destination address");
  }
  const source = readAddress(bytes, offset);
  offset += ADDRESS_ENCODED_LENGTH;

  const digipeaters: Ax25Address[] = [];
  let last: Ax25Address = source;
  while (!last.extensionBit) {
    if (digipeaters.length >= MAX_DIGIPEATERS) {
      throw new Error(
        `E-bit not reached within ${MAX_DIGIPEATERS} digipeaters`,
      );
    }
    if (bytes.length < offset + ADDRESS_ENCODED_LENGTH) {
      throw new Error("truncated digipeater chain");
    }
    last = readAddress(bytes, offset);
    offset += ADDRESS_ENCODED_LENGTH;
    digipeaters.push(last);
  }

  if (bytes.length < offset + 1) {
    throw new Error("missing control byte");
  }
  const control = bytes[offset++]!;
  let controlExtension: number | null = null;

  // Extended (mod-128) I and S frames carry a 2-octet control field (Fig 4.1b);
  // U frames are 1 octet in both modes. The width can't be told from the first
  // octet alone, so the caller supplies the link's modulo via `extended`.
  // Frame-type discriminator: bit 0 = 0 → I; bits 1-0 = 01 → S; bits 1-0 = 11
  // → U.
  const isUFrame = (control & 0x03) === 0x03;
  if (extended && !isUFrame) {
    if (bytes.length < offset + 1) {
      throw new Error("missing extended control byte");
    }
    controlExtension = bytes[offset++]!;
  }

  let pid: number | null = null;
  let info: Uint8Array = new Uint8Array(0);

  const isUi = (control & 0xef) === CONTROL_UI;
  const isI = (control & 0x01) === 0;
  if (isUi || isI) {
    if (bytes.length < offset + 1) {
      throw new Error("missing PID byte");
    }
    pid = bytes[offset++]!;
    info = bytes.slice(offset);
  } else if (offset < bytes.length) {
    // S-frames / non-info U-frames: be lenient and capture trailing bytes.
    info = bytes.slice(offset);
  }

  return { destination, source, digipeaters, control, controlExtension, pid, info };
}

// ─── Factories ────────────────────────────────────────────────────────────

function makeAddressChain(
  dest: Callsign,
  src: Callsign,
  via: readonly Callsign[],
  isCmd: boolean,
): { destination: Ax25Address; source: Ax25Address; digipeaters: Ax25Address[] } {
  if (via.length > MAX_DIGIPEATERS) {
    throw new Error(
      `AX.25 allows at most ${MAX_DIGIPEATERS} digipeaters (got ${via.length})`,
    );
  }
  const noDigi = via.length === 0;
  const destination: Ax25Address = {
    callsign: dest,
    crhBit: isCmd,
    extensionBit: false,
  };
  const source: Ax25Address = {
    callsign: src,
    crhBit: !isCmd,
    extensionBit: noDigi,
  };
  const digipeaters: Ax25Address[] = via.map((c, i) => ({
    callsign: c,
    crhBit: false,
    extensionBit: i === via.length - 1,
  }));
  return { destination, source, digipeaters };
}

export interface FrameFactoryOpts {
  destination: Callsign;
  source: Callsign;
  digipeaters?: readonly Callsign[];
}

/** Build a SABM (Set Async Balanced Mode, mod-8) command frame. */
export function sabm(opts: FrameFactoryOpts & { pollBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  return {
    ...chain,
    control: (CONTROL_SABM | (opts.pollBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/**
 * Build a SABME (Set Async Balanced Mode Extended) command frame — the
 * request to bring the link up in extended (mod-128) modulo.
 *
 * SABME is itself a U frame, so its control field is a single octet in both
 * modulos (Fig 4.1a/4.1b — only I and S frames widen to 2 octets under
 * mod-128); hence `controlExtension` is `null`. It is the *negotiation*
 * frame: once both ends agree on SABME, the link's subsequent I/S frames
 * carry the 2-octet extended control field built by {@link iFrame} /
 * {@link rr} / … with `extended: true`.
 */
export function sabme(opts: FrameFactoryOpts & { pollBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  return {
    ...chain,
    control: (CONTROL_SABME | (opts.pollBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a DISC command frame. */
export function disc(opts: FrameFactoryOpts & { pollBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  return {
    ...chain,
    control: (CONTROL_DISC | (opts.pollBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a UA response frame. */
export function ua(opts: FrameFactoryOpts & { finalBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, false);
  return {
    ...chain,
    control:
      (CONTROL_UA | (opts.finalBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a DM response frame. */
export function dm(opts: FrameFactoryOpts & { finalBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, false);
  return {
    ...chain,
    control:
      (CONTROL_DM | (opts.finalBit ?? false ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a UI frame. Command/response per `isCommand`. */
export function ui(
  opts: FrameFactoryOpts & {
    info: Uint8Array;
    pid?: number;
    isCommand?: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], info } = opts;
  const isCmd = opts.isCommand ?? true;
  const chain = makeAddressChain(destination, source, digipeaters, isCmd);
  return {
    ...chain,
    control: (CONTROL_UI | (opts.pollFinal ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: opts.pid ?? PID_NO_LAYER_3,
    info,
  };
}

/**
 * Build an Exchange Identification (XID) frame per §4.3.3.7 — the U-frame that
 * carries an XID parameter-negotiation information field (built by
 * {@link encodeXid}). XID may be sent as a command (the initiator's offer) or a
 * response (the responder's agreed set); the C/R bit is set per `isCommand`.
 * The MDL (Management Data-Link, App. C5) exchange drives this. Mirrors the C#
 * `Ax25Frame.Xid`. XID carries no PID (§3.5 lists the info-bearing U frames —
 * FRMR / XID / TEST — none of which carry a PID octet).
 */
export function xid(
  opts: FrameFactoryOpts & {
    info: Uint8Array;
    isCommand: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], info } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, opts.isCommand);
  return {
    ...chain,
    control: (CONTROL_XID | (opts.pollFinal ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info,
  };
}

/**
 * Build a Frame Reject (FRMR) response frame per §4.3.3.9. The 3-octet info
 * field carrying the rejection cause is supplied by the caller — this factory
 * does not construct it. A pre-v2.2 peer answers an XID command with FRMR
 * (§6.3.2 ¶1), which the MDL maps onto the version-2.0 fallback. Mirrors the C#
 * `Ax25Frame.Frmr` (response only — FRMR is never a command). Carries no PID.
 */
export function frmr(
  opts: FrameFactoryOpts & {
    info: Uint8Array;
    finalBit?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], info } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, false);
  return {
    ...chain,
    control: (CONTROL_FRMR | (opts.finalBit ? CONTROL_PF_BIT : 0)) & 0xff,
    controlExtension: null,
    pid: null,
    info,
  };
}

/**
 * Build the second control octet of an extended (mod-128) I or S frame:
 * `(N(R) << 1) | (P/F)` per Fig 4.1b (7-bit N(R) in bits 7-1, P/F in bit 0).
 */
function extendedControl(nr: number, pollFinalBit: boolean): number {
  return (((nr & 0x7f) << 1) | (pollFinalBit ? CONTROL_EXT_PF_BIT : 0)) & 0xff;
}

/**
 * Build a supervisory frame in either modulo. Mod-8 packs N(R)/P-F into the
 * single control octet (`(N(R) << 5) | (P/F << 4) | base`); extended mod-128
 * (Fig 4.3b) keeps the base octet (SS bits + "01", high nibble zero) as octet0
 * and puts `(N(R) << 1) | P/F` in octet1. Shared by {@link rr} / {@link rnr} /
 * {@link rej} / {@link srej}; mirrors the C# `Ax25Frame.SFrameAt`.
 */
function buildSupervisoryFrame(
  base: number,
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, opts.isCommand);
  if (opts.extended) {
    return {
      ...chain,
      control: base & 0xff,
      controlExtension: extendedControl(nr, opts.pollFinal ?? false),
      pid: null,
      info: new Uint8Array(0),
    };
  }
  const control =
    (((nr & 0x07) << 5) | (opts.pollFinal ? CONTROL_PF_BIT : 0) | base) & 0xff;
  return {
    ...chain,
    control,
    controlExtension: null,
    pid: null,
    info: new Uint8Array(0),
  };
}

/**
 * Build a Receive Ready (RR) supervisory frame. Set `extended` for the
 * mod-128 2-octet control field (Fig 4.3b).
 */
export function rr(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  return buildSupervisoryFrame(CONTROL_RR, opts);
}

/**
 * Build a Receive Not Ready (RNR) supervisory frame. Set `extended` for the
 * mod-128 2-octet control field (Fig 4.3b).
 */
export function rnr(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  return buildSupervisoryFrame(CONTROL_RNR, opts);
}

/**
 * Build a REJ supervisory frame. Set `extended` for the mod-128 2-octet
 * control field (Fig 4.3b).
 */
export function rej(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  return buildSupervisoryFrame(CONTROL_REJ, opts);
}

/**
 * Build a Selective REJect (SREJ) supervisory frame per §4.3.2.4. N(R) is the
 * sequence number of the *single* I-frame being requested for retransmission
 * (the gap). SREJ is response-only in practice (§4.3.2.4 / no deployed stack
 * sends an SREJ command), but the factory accepts `isCommand` to mirror the
 * RR/RNR/REJ factories and the C# `Ax25Frame.Srej`. Mod-8 control:
 * `(N(R) << 5) | (P/F << 4) | 0x0D`; set `extended` for the mod-128 2-octet
 * control field (Fig 4.3b).
 */
export function srej(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  return buildSupervisoryFrame(CONTROL_SREJ, opts);
}

/**
 * Build an Information (I) frame. Always a command per AX.25 v2.2 §4.3.1.
 * Mod-8 control: `(N(R) << 5) | (P << 4) | (N(S) << 1) | 0`. Set `extended`
 * for the mod-128 2-octet control field (Fig 4.2b): octet0 = `(N(S) << 1) | 0`
 * (7-bit N(S), bit 0 = 0); octet1 = `(N(R) << 1) | P` (7-bit N(R), bit 0 = P).
 */
export function iFrame(
  opts: FrameFactoryOpts & {
    nr: number;
    ns: number;
    info: Uint8Array;
    pid?: number;
    pollBit?: boolean;
    extended?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr, ns, info } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  if (opts.extended) {
    return {
      ...chain,
      control: ((ns & 0x7f) << 1) & 0xff,
      controlExtension: extendedControl(nr, opts.pollBit ?? false),
      pid: opts.pid ?? PID_NO_LAYER_3,
      info,
    };
  }
  const control =
    (((nr & 0x07) << 5) |
      (opts.pollBit ? CONTROL_PF_BIT : 0) |
      ((ns & 0x07) << 1)) &
    0xff;
  return {
    ...chain,
    control,
    controlExtension: null,
    pid: opts.pid ?? PID_NO_LAYER_3,
    info,
  };
}
