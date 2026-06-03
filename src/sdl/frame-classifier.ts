import type { Ax25Frame } from "../frame.js";
import type { Ax25Event } from "./events.js";

/**
 * Classifies a parsed {@link Ax25Frame} into the matching {@link Ax25Event} the
 * SDL dispatcher should receive on the inbound path. The TypeScript analogue of
 * the C# `Ax25FrameClassifier` (`Packet.Ax25.Session`); runtime behaviour
 * defers to that reference.
 *
 * Inverse of the frame factories — those go event/spec → frame → bytes for
 * outbound; this goes bytes (already parsed to a frame) → event for inbound,
 * ready to feed into a session driver's `postEvent`.
 *
 * Pure function over the control byte and frame-level properties — no session
 * state needed. It reads only the frame's bit-level shape; it does not know
 * whether the frame is destined for us (the listener address-filters first).
 *
 * Modulo-independent: the I/S/U discriminator (bit 0; bits 1-0), the S-frame
 * subtype (SS bits) and the U-frame subtype all live in the first control octet,
 * which is identical under mod-8 and extended mod-128 (Fig 4.1a/4.1b). The
 * classifier reads only that octet, so it classifies an extended frame correctly
 * without knowing the modulo; the 7-bit N(R)/N(S) (which *do* differ by modulo)
 * are decoded later, mode-aware, via {@link getNr} / {@link getNs}.
 */

// U-frame control-byte bases (§4.3.3), P/F masked off — kept local to mirror the
// C# classifier's self-contained switch rather than reaching into frame.ts.
const U_SABM = 0x2f;
const U_SABME = 0x6f;
const U_DISC = 0x43;
const U_UA = 0x63;
const U_DM = 0x0f;
const U_UI = 0x03;
const U_FRMR = 0x87;
const U_XID = 0xaf;
const U_TEST = 0xe3;

/**
 * Map an inbound {@link Ax25Frame} to the {@link Ax25Event} the dispatcher
 * should receive.
 *
 * Returns a typed frame-receipt event (`SABM_received`, `I_received`,
 * `RR_received`, …) when the control byte matches a known frame type. A
 * spec-violating frame maps to the matching data-link error event so the
 * figc4.x error-input transition fires (DL-ERROR + re-establish) instead of the
 * frame being silently processed:
 *
 *   - an information field on an S frame or a no-info U frame
 *     (SABM/SABME/DISC/UA/DM) → `info_not_permitted_in_frame` (DL-ERROR M);
 *   - an unknown U-frame control byte → `control_field_error`.
 *
 * Mirrors C# `Ax25FrameClassifier.Classify`. The PID/info-bearing UI/FRMR/XID/
 * TEST frames are unaffected by the info check (they legitimately carry info).
 */
export function classifyFrame(frame: Ax25Frame): Ax25Event {
  const ctrl = frame.control;

  // I-frame: bit 0 = 0 — the discriminator between I and S/U.
  if ((ctrl & 0x01) === 0) {
    return { name: "I_received", frame };
  }

  // S-frame: bits 1-0 = 01. SS bits at positions 3-2 pick the subtype; the P/F
  // bit (4) and N(R) bits (7-5) don't affect classification.
  if ((ctrl & 0x03) === 0x01) {
    // S frames carry no information field (§3.5). One present — accepted only
    // under a lenient parse; STRICT_PARSE rejects it at decode — is the
    // data-link "information not permitted in frame" error (DL-ERROR M),
    // surfaced here so the figc4.x error-input transition fires rather than the
    // frame being silently processed as a plain RR.
    if (frame.info.length > 0) {
      return { name: "info_not_permitted_in_frame" };
    }
    switch (ctrl & 0x0c) {
      case 0x00:
        return { name: "RR_received", frame }; // 0001
      case 0x04:
        return { name: "RNR_received", frame }; // 0101
      case 0x08:
        return { name: "REJ_received", frame }; // 1001
      default:
        return { name: "SREJ_received", frame }; // 1101
    }
  }

  // U-frame: bits 1-0 = 11. MMM at bits 7-5 and MM at bits 3-2 identify the
  // subtype; mask out the P/F bit (4) to get the base control octet.
  const uBase = ctrl & 0xef;
  const hasInfo = frame.info.length > 0;
  switch (uBase) {
    // SABM/SABME/DISC/UA/DM carry no information field (§3.5). One present —
    // accepted only under a lenient parse — is the data-link "information not
    // permitted in frame" error (DL-ERROR M), so the figc4.x error-input
    // transition fires instead of the frame being silently processed.
    case U_SABM:
      return hasInfo ? { name: "info_not_permitted_in_frame" } : { name: "SABM_received", frame };
    case U_SABME:
      return hasInfo ? { name: "info_not_permitted_in_frame" } : { name: "SABME_received", frame };
    case U_DISC:
      return hasInfo ? { name: "info_not_permitted_in_frame" } : { name: "DISC_received", frame };
    case U_UA:
      return hasInfo ? { name: "info_not_permitted_in_frame" } : { name: "UA_received", frame };
    case U_DM:
      return hasInfo ? { name: "info_not_permitted_in_frame" } : { name: "DM_received", frame };
    // FRMR/XID/TEST/UI legitimately carry an information field.
    case U_FRMR:
      return { name: "FRMR_received", frame };
    case U_XID:
      return { name: "XID_received", frame };
    case U_TEST:
      return { name: "TEST_received", frame };
    case U_UI:
      return { name: "UI_received", frame };
    default:
      // Unknown U-frame control byte — no valid mod-8/mod-128 frame pattern.
      return { name: "control_field_error" };
  }
}
