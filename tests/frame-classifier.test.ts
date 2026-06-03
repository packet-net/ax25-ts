/**
 * Unit coverage for {@link classifyFrame} — the inbound frame → SDL event
 * classifier. TS port of `tests/Packet.Ax25.Tests/Session/Ax25FrameClassifierTests.cs`;
 * runtime behaviour mirrors that C# reference (`Ax25FrameClassifier.Classify`).
 *
 * The classifier maps a parsed frame to the {@link Ax25Event} the dispatcher
 * should receive. The load-bearing cases this guards:
 *
 *   - every well-formed I/S/U frame → its `*_received` event;
 *   - a spec-violating *info-bearing* S frame or no-info U frame
 *     (SABM/SABME/DISC/UA/DM) → `info_not_permitted_in_frame` (DL-ERROR M);
 *   - an unknown U-frame control byte → `control_field_error`;
 *   - the legitimately info-bearing U frames (FRMR/XID/TEST/UI) are NOT misfired
 *     by the info check.
 *
 * Plus the strict/lenient paired decode assertion (CLAUDE-rule: a pragmatic
 * accommodation is a named flag) — STRICT_PARSE rejects the info-bearing S/U
 * frame at the wire; LENIENT_PARSE (the default) accepts it so the classifier
 * can surface the data-link error.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  LENIENT_PARSE,
  STRICT_PARSE,
  decodeFrame,
  disc,
  dm,
  encodeFrame,
  frmr,
  iFrame,
  rej,
  rnr,
  rr,
  sabm,
  sabme,
  srej,
  ua,
  ui,
  xid,
} from "../src/frame.js";
import { classifyFrame } from "../src/sdl/frame-classifier.js";

const Local = Callsign.parse("M0LTE");
const Remote = Callsign.parse("G7XYZ-7");

/** Append trailing bytes to a frame's wire form and decode (lenient) — produces
 * an info-bearing frame the way a noisy / spec-violating peer would send one.
 * Mirrors the C# `WithTrailingInfo` helper. */
function withTrailingInfo(frame: Ax25Frame, ...info: number[]): Ax25Frame {
  const base = encodeFrame(frame);
  const bytes = new Uint8Array(base.length + info.length);
  bytes.set(base, 0);
  bytes.set(Uint8Array.from(info), base.length);
  return decodeFrame(bytes, false, LENIENT_PARSE);
}

describe("classifyFrame — U-frame classification (§4.3.3 control bytes)", () => {
  it.each([true, false])("SABM (poll=%s) → SABM_received", (poll) => {
    expect(classifyFrame(sabm({ destination: Local, source: Remote, pollBit: poll })).name).toBe(
      "SABM_received",
    );
  });

  it("SABME → SABME_received", () => {
    expect(classifyFrame(sabme({ destination: Local, source: Remote })).name).toBe("SABME_received");
  });

  it("DISC → DISC_received", () => {
    expect(classifyFrame(disc({ destination: Local, source: Remote })).name).toBe("DISC_received");
  });

  it("UA → UA_received", () => {
    expect(classifyFrame(ua({ destination: Local, source: Remote })).name).toBe("UA_received");
  });

  it("DM → DM_received", () => {
    expect(classifyFrame(dm({ destination: Local, source: Remote })).name).toBe("DM_received");
  });

  it("FRMR → FRMR_received", () => {
    expect(
      classifyFrame(frmr({ destination: Local, source: Remote, info: new Uint8Array([0, 0, 0]) }))
        .name,
    ).toBe("FRMR_received");
  });

  it.each([true, false])("XID (command=%s) → XID_received", (cmd) => {
    expect(
      classifyFrame(
        xid({ destination: Local, source: Remote, info: new Uint8Array(0), isCommand: cmd }),
      ).name,
    ).toBe("XID_received");
  });

  it.each([true, false])("UI (pollFinal=%s) → UI_received", (pf) => {
    expect(
      classifyFrame(
        ui({
          destination: Local,
          source: Remote,
          info: new TextEncoder().encode("hi"),
          pollFinal: pf,
        }),
      ).name,
    ).toBe("UI_received");
  });

  // TEST has no TS factory; build its bytes (U-base 0xE3) directly and decode.
  it("TEST (control 0xE3) → TEST_received", () => {
    const probe = ui({ destination: Local, source: Remote, info: new Uint8Array(0) });
    const bytes = encodeFrame(probe);
    bytes[14] = 0xe3; // overwrite the (no-digi) control octet with the TEST base
    const decoded = decodeFrame(bytes);
    expect(classifyFrame(decoded).name).toBe("TEST_received");
  });
});

describe("classifyFrame — S-frame classification (§4.3.2)", () => {
  it.each([
    [0, false],
    [5, true],
    [7, false],
  ])("RR (nr=%s, pf=%s) → RR_received regardless of N(R)/P-F", (nr, pf) => {
    expect(
      classifyFrame(rr({ destination: Local, source: Remote, nr, isCommand: false, pollFinal: pf }))
        .name,
    ).toBe("RR_received");
  });

  it("RNR → RNR_received", () => {
    expect(
      classifyFrame(rnr({ destination: Local, source: Remote, nr: 3, isCommand: false })).name,
    ).toBe("RNR_received");
  });

  it("REJ → REJ_received", () => {
    expect(
      classifyFrame(rej({ destination: Local, source: Remote, nr: 2, isCommand: false })).name,
    ).toBe("REJ_received");
  });

  // Regression: the listener's old `mapKindToEvent` dropped SREJ on the floor
  // (it had no SREJ case → returned null → frame discarded). The C# classifier
  // maps it; classifyFrame must too.
  it("SREJ → SREJ_received", () => {
    expect(
      classifyFrame(srej({ destination: Local, source: Remote, nr: 1, isCommand: false })).name,
    ).toBe("SREJ_received");
  });
});

describe("classifyFrame — I-frame classification (§4.3.1)", () => {
  it.each([
    [0, 0, false],
    [5, 3, true],
    [7, 7, false],
  ])("I (nr=%s, ns=%s) → I_received regardless of seq vars", (nr, ns, poll) => {
    const f = iFrame({
      destination: Local,
      source: Remote,
      nr,
      ns,
      info: new TextEncoder().encode("x"),
      pollBit: poll,
    });
    const event = classifyFrame(f);
    expect(event.name).toBe("I_received");
    expect(event.frame).toBe(f);
  });
});

describe("classifyFrame — unknown / malformed control byte", () => {
  // U-frame shape (bits 1-0 = 11) but the subtype bits match no known type.
  it.each([0x17, 0xc3, 0xfb])("unknown U-frame control 0x%s → control_field_error", (ctrl) => {
    const probe = sabm({ destination: Local, source: Remote });
    const bytes = encodeFrame(probe);
    bytes[14] = ctrl; // overwrite the (no-digi) control octet
    const decoded = decodeFrame(bytes);
    expect(decoded.control).toBe(ctrl);
    expect(classifyFrame(decoded).name).toBe("control_field_error");
  });
});

describe("classifyFrame — information not permitted (§3.5 / DL-ERROR M)", () => {
  it("an S frame carrying an information field → info_not_permitted_in_frame", () => {
    const rrFrame = rr({ destination: Local, source: Remote, nr: 0, isCommand: false });
    const infoBearing = withTrailingInfo(rrFrame, 0x01, 0x02);
    expect(infoBearing.info.length).toBe(2);
    expect(classifyFrame(infoBearing).name).toBe("info_not_permitted_in_frame");
  });

  it("a no-info U frame (SABM/DISC/UA/DM) carrying info → info_not_permitted_in_frame", () => {
    for (const frame of [
      sabm({ destination: Local, source: Remote }),
      disc({ destination: Local, source: Remote }),
      ua({ destination: Local, source: Remote }),
      dm({ destination: Local, source: Remote }),
    ]) {
      const infoBearing = withTrailingInfo(frame, 0x99);
      expect(classifyFrame(infoBearing).name).toBe("info_not_permitted_in_frame");
    }
  });

  it("the info-bearing U frames (FRMR/XID/TEST/UI) are NOT misfired by the info check", () => {
    expect(
      classifyFrame(frmr({ destination: Local, source: Remote, info: new Uint8Array([0, 0, 0]) }))
        .name,
    ).toBe("FRMR_received");
    expect(
      classifyFrame(
        xid({
          destination: Local,
          source: Remote,
          info: new Uint8Array([1, 2, 3]),
          isCommand: true,
        }),
      ).name,
    ).toBe("XID_received");
    expect(
      classifyFrame(
        ui({ destination: Local, source: Remote, info: new TextEncoder().encode("hi") }),
      ).name,
    ).toBe("UI_received");
  });

  it("the error events carry no frame (mirrors the C# parameterless InfoNotPermittedInFrame / ControlFieldError)", () => {
    const infoBearingDm = withTrailingInfo(dm({ destination: Local, source: Remote }), 0x99);
    expect(classifyFrame(infoBearingDm).frame).toBeUndefined();

    const probe = sabm({ destination: Local, source: Remote });
    const bytes = encodeFrame(probe);
    bytes[14] = 0x17;
    expect(classifyFrame(decodeFrame(bytes)).frame).toBeUndefined();
  });
});

describe("decodeFrame — strict vs lenient parse (named-flag discipline)", () => {
  it("STRICT_PARSE rejects info on an S frame at the wire; LENIENT_PARSE accepts → classifier flags it", () => {
    const base = encodeFrame(rr({ destination: Local, source: Remote, nr: 0, isCommand: false }));
    const bytes = new Uint8Array(base.length + 2);
    bytes.set(base, 0);
    bytes.set([0x01, 0x02], base.length);

    expect(() => decodeFrame(bytes, false, STRICT_PARSE)).toThrow();
    const lenient = decodeFrame(bytes, false, LENIENT_PARSE);
    expect(lenient.info.length).toBe(2);
    expect(classifyFrame(lenient).name).toBe("info_not_permitted_in_frame");
  });

  it("STRICT_PARSE rejects info on a no-info U frame (DM); LENIENT_PARSE accepts", () => {
    const base = encodeFrame(dm({ destination: Local, source: Remote }));
    const bytes = new Uint8Array(base.length + 1);
    bytes.set(base, 0);
    bytes[base.length] = 0x99;

    expect(() => decodeFrame(bytes, false, STRICT_PARSE)).toThrow();
    expect(decodeFrame(bytes, false, LENIENT_PARSE).info.length).toBe(1);
  });

  it("STRICT_PARSE still accepts info on the legitimately info-bearing U frames (FRMR/XID/TEST)", () => {
    // FRMR carries a 3-octet info field — strict must NOT reject it.
    const frmrBytes = encodeFrame(
      frmr({ destination: Local, source: Remote, info: new Uint8Array([1, 2, 3]) }),
    );
    const decoded = decodeFrame(frmrBytes, false, STRICT_PARSE);
    expect(decoded.info.length).toBe(3);
    expect(classifyFrame(decoded).name).toBe("FRMR_received");
  });

  it("decodeFrame defaults to lenient (the C# parameterless-decoder default)", () => {
    const base = encodeFrame(dm({ destination: Local, source: Remote }));
    const bytes = new Uint8Array(base.length + 1);
    bytes.set(base, 0);
    bytes[base.length] = 0x99;
    // No options arg → must NOT throw (lenient), keeping the trailing byte.
    expect(decodeFrame(bytes).info.length).toBe(1);
  });
});
