import type { Callsign } from "../callsign.js";
import {
  NETROM_SHIFTED_LENGTH,
  tryReadShifted,
  writeShifted,
} from "./callsign.js";

/**
 * Codec for the information field carried by a NET/ROM L4 **Connect Request**
 * (opcode 0x01) — the one transport message whose info field has a defined
 * structure (the others carry user data or are empty). It conveys the *proposed
 * send-window* and the *originating user + originating node* callsigns
 * end-to-end, so the accepting node knows who is calling and can negotiate the
 * window down.
 *
 * Wire layout (the de-facto NET/ROM form), 15 octets at the front of the Connect
 * Request info field:
 * ```
 *   [1] proposed send-window size (1..127)
 *   [7] originating user callsign  (AX.25 shifted form)
 *   [7] originating node callsign  (AX.25 shifted form)
 *   (any trailing octets are an implementation extension — e.g. LinBPQ appends a
 *    timeout/flags pair — and are ignored on parse)
 * ```
 *
 * **Why the window lives here, not in the transport header.** The 5-octet
 * transport header's TX/RX-sequence slots are 0 on a Connect Request; the
 * proposed window is the *first info octet*. This was verified on the wire
 * against a real LinBPQ 6.0.25.23 over the interop stack (#308 follow-up): BPQ
 * both *originates* its Connect Request as `[window][user][node][bpq-extra…]` and
 * *accepts* ours in the same shape; the earlier placement of the window in the
 * transport-header TX byte was a divergence that mis-set the negotiated window.
 * The originating callsigns being in the info field is the canonical NET/ROM
 * appendix behaviour. Construction is strict (we always emit the canonical
 * 15-octet form); parsing is total and tolerant of trailing extension octets.
 *
 * Mirrors `Packet.NetRom.Wire.ConnectRequestInfo` on the C# side.
 */

/**
 * Octets the canonical Connect Request info field occupies (window + two shifted
 * callsigns). A peer may append extension octets after these.
 */
export const CONNECT_REQUEST_INFO_LENGTH =
  1 + NETROM_SHIFTED_LENGTH + NETROM_SHIFTED_LENGTH; // 15

/**
 * The decoded Connect Request info field. Mirrors the C# `out` triple
 * (`proposedWindow`, `originatingUser`, `originatingNode`).
 */
export interface ConnectRequestInfo {
  /** The proposed send-window size (the first info octet). */
  readonly proposedWindow: number;
  /** The calling user's callsign (AX.25 shifted form). */
  readonly originatingUser: Callsign;
  /** The calling node's callsign (AX.25 shifted form). */
  readonly originatingNode: Callsign;
}

/**
 * Build the Connect Request info field: proposed window then the originating user
 * + node callsigns (both AX.25 shifted).
 *
 * Mirrors `ConnectRequestInfo.Build` on the C# side.
 */
export function buildConnectRequestInfo(
  proposedWindow: number,
  originatingUser: Callsign,
  originatingNode: Callsign,
): Uint8Array {
  const buf = new Uint8Array(CONNECT_REQUEST_INFO_LENGTH);
  buf[0] = proposedWindow & 0xff;
  writeShifted(originatingUser, buf, 1);
  writeShifted(originatingNode, buf, 1 + NETROM_SHIFTED_LENGTH);
  return buf;
}

/**
 * Parse the proposed window + originating user/node from a Connect Request info
 * field. Returns `null` (never throws) if the field is shorter than the 15-octet
 * canonical layout or a callsign field is undecodable. Trailing octets beyond the
 * 15 (a peer's extension) are ignored.
 *
 * Mirrors `ConnectRequestInfo.TryParse` on the C# side.
 */
export function tryParseConnectRequestInfo(
  info: Uint8Array,
  offset = 0,
): ConnectRequestInfo | null {
  if (info.length < offset + CONNECT_REQUEST_INFO_LENGTH) {
    return null;
  }

  const proposedWindow = info[offset]!;
  const originatingUser = tryReadShifted(info, offset + 1);
  if (originatingUser === null) {
    return null;
  }
  const originatingNode = tryReadShifted(
    info,
    offset + 1 + NETROM_SHIFTED_LENGTH,
  );
  if (originatingNode === null) {
    return null;
  }
  return { proposedWindow, originatingUser, originatingNode };
}
