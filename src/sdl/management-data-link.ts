import { type Ax25Frame, xid as buildXid } from "../frame.js";
import {
  CLASSES_OF_PROCEDURES_FULL_DUPLEX,
  CLASSES_OF_PROCEDURES_HALF_DUPLEX,
  encodeXid,
  octetsToBits,
  type RejectMode,
  tryParseXid,
  type XidParameters,
} from "../xid.js";
import type { MdlSignal, TransitionContext } from "./action-dispatcher.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "./session-context.js";
import { MDL_STATE_PAGES, SdlSessionDriver } from "./session-driver.js";
import type { TimerScheduler } from "./timer-scheduler.js";
import {
  applyNegotiated,
  applyVersion20Defaults,
} from "./xid-negotiator.js";

/**
 * The runtime driver for the AX.25 v2.2 **management data-link (MDL)** state
 * machine — the XID parameter-negotiation FSM of Appendix C5 (figc5.1 `Ready` /
 * figc5.2 `Negotiating`). It consumes the `MDL-NEGOTIATE Request` poke the
 * data-link side emits after the UA on a v2.2 connect (figc4.6), and drives the
 * single XID command/response exchange that turns SREJ / segmentation / modulo
 * / window / T1 / N2 from config-flag-forced defaults into *negotiated* link
 * parameters.
 *
 * This is a small (2-state) sibling of {@link Ax25Session} / the listener
 * session. It is driven from the same generated tables ({@link MDL_STATE_PAGES})
 * through the same {@link SdlSessionDriver} / {@link ActionDispatcher} /
 * {@link GuardEvaluator} machinery the data-link uses — reusing that
 * infrastructure rather than hand-rolling a second interpreter. The
 * MDL-specific behaviour rides on the dispatcher's injectable MDL hooks (the
 * `XID_command` builder, the `Apply Negotiated Parameters` merge, the full-v2.0
 * `set_version_2_0`, the MDL→L3 signal sink, the TM201 timer).
 *
 * **State isolation.** The MDL machine reads/writes `RC` and arms TM201; the
 * data-link session has its own `RC` and T1/T2/T3. To keep the two retry/timer
 * regimes from colliding, the MDL driver runs the generated tables against its
 * *own* {@link Ax25SessionContext} and timer scheduler. The negotiated
 * parameters are applied to the *real* data-link context ({@link linkContext}) —
 * that is the whole point of the exercise. `NM201` (the management retry limit)
 * maps onto the MDL context's `n2`.
 *
 * **Provenance.** The MDL SDL pages are a deliberate prose-derived bootstrap
 * (Tom-directed; figc5.x not yet redrawn, marked `verification_pending`). The
 * figc5.3–figc5.8 per-parameter "reverts-to" subroutines are collapsed in the
 * SDL to a single `Apply Negotiated Parameters` placeholder; its runtime body
 * lives in {@link applyNegotiated} ({@link xid-negotiator}).
 *
 * The TypeScript parity leg of packet.net's
 * `Packet.Ax25.Session.Ax25ManagementDataLink` (m0lte/packet.net#271, v2.2 arc
 * V3 part 2).
 */
export class Ax25ManagementDataLink {
  private readonly driver: SdlSessionDriver;
  private readonly mdlContext: Ax25SessionContext;
  private readonly linkContext: Ax25SessionContext;
  private readonly explicitOffer: XidParameters | undefined;
  private readonly sendFrame: (frame: Ax25Frame) => void;
  private readonly mdlSignalListeners: Array<(signal: MdlSignal) => void> = [];

  /**
   * Our XID offer — an explicit set if one was supplied at construction, else
   * derived from the *current* link context (so a context mutated between
   * construction and negotiation is reflected). Used as the "our offer" half of
   * the §6.3.2 merge on both the initiator and responder sides, and as the
   * payload of the XID command/response we emit.
   */
  private get offered(): XidParameters {
    return this.explicitOffer ?? Ax25ManagementDataLink.defaultOfferFor(this.linkContext);
  }

  /**
   * Construct an MDL driver bound to a data-link session's state.
   *
   * @param linkContext The data-link {@link Ax25SessionContext} whose parameters
   *   the negotiation will replace (SREJ / modulo / k / N1 / T1V / N2).
   * @param scheduler The timer scheduler used for TM201. May be shared with the
   *   data-link session's scheduler — TM201 is a distinct timer name, so it does
   *   not collide with T1/T2/T3 — or a dedicated one.
   * @param sendFrame Sink for outgoing frame bytes — the MDL uses it to put the
   *   XID command/response on the wire. Same shape as the session's frame sink.
   * @param offered Our offered XID parameter set (our Rx capability /
   *   preferences) — sent in the XID command and used as the "our offer" half of
   *   the §6.3.2 merge. When omitted, {@link defaultOfferFor} derives a sensible
   *   offer from the current `linkContext`.
   * @param nm201 Maximum number of XID-command retries (§C5.3). Defaults to the
   *   data-link N2 value of `linkContext`.
   */
  constructor(
    linkContext: Ax25SessionContext,
    scheduler: TimerScheduler,
    sendFrame: (frame: Ax25Frame) => void,
    offered?: XidParameters,
    nm201?: number,
  ) {
    this.linkContext = linkContext;
    this.explicitOffer = offered;
    this.sendFrame = sendFrame;

    // The MDL machine runs against its own context so its RC / NM201 / TM201
    // bookkeeping never disturbs the live data-link session. NM201 lives in
    // this context's n2; addressing mirrors the link so the XID command is
    // built with the right local/remote (digipeaters omitted — the v1 stack is
    // direct-link only).
    this.mdlContext = createSessionContext(linkContext.local, linkContext.remote);
    this.mdlContext.n2 = nm201 ?? linkContext.n2;

    // figc5.2's TM201-expiry retry-limit diamond: RC == NM201 (NM201 in the MDL
    // context's n2). F_eq_1 and the rest of the frame-aware predicates come from
    // the standard binding table (createSessionBindings), reading the MDL
    // machine's current trigger frame. Mirrors C#'s RC_eq_NM201 added over the
    // default bindings.
    const extraBindings = new Map<string, () => boolean>([
      ["RC_eq_NM201", () => this.mdlContext.rc === this.mdlContext.n2],
    ]);

    this.driver = new SdlSessionDriver(
      this.mdlContext,
      scheduler,
      {
        // The MDL machine emits no data-link frames; XID goes out via
        // sendXidCommand, FRMR/UA never. A bare sink satisfies the contract.
        sendFrame: () => {
          /* MDL emits no data-link supervisory/U frames directly */
        },
        // The MDL machine raises no DataLinkSignal; its upward primitives are
        // MdlSignals, routed through the mdl.sendMdl hook below.
        emitUpward: () => {
          /* MDL has no DataLinkSignal output */
        },
        // Unmatched events are SDL no-ops (e.g. an XID response in Ready that
        // isn't error-B-shaped, a FRMR in Ready) — never a throw.
        onUnhandledEvent: () => {},
        extraBindings,
        mdl: {
          // XID_command (signal_lower): build + send our XID command frame.
          sendXidCommand: () => this.sendFrame(this.buildXidCommand()),
          // Apply Negotiated Parameters: parse the peer's XID response off the
          // triggering frame and run the §6.3.2 reverts-to merge into the REAL
          // data-link context.
          applyNegotiatedParameters: (tx) => this.onApplyNegotiatedParameters(tx),
          // MDL → Layer 3 primitives.
          sendMdl: (signal) => this.emitMdlSignal(signal),
          // set_version_2_0 here means the COMPLETE §1436 v2.0 default set
          // applied to the real link context (not merely isExtended=false) —
          // the figc5.2 FRMR path draws a single "Set Version 2.0" box.
          setVersion20: () => applyVersion20Defaults(this.linkContext),
        },
        // TM201 is left at the dispatcher default (3000 ms — the management
        // analogue of T1; §C5.3 gives no numeric default). We do NOT seed it
        // from linkContext.t1vMs: the MDL driver is built before the data-link
        // connects, and the figc4.x establishment resets T1V afterwards, so a
        // value captured now would be stale. The negotiation outcome is
        // independent of the retry cadence; only the give-up timing depends on
        // TM201, and 3000 ms is the spec's T1 default.
      },
      "Ready",
      MDL_STATE_PAGES,
    );
  }

  /** The real data-link session state the negotiated parameters are applied to. */
  get context(): Ax25SessionContext {
    return this.linkContext;
  }

  /** Current MDL state — `Ready` or `Negotiating`. */
  get state(): string {
    return this.driver.currentState;
  }

  /**
   * True while a negotiation is in progress (the MDL is in `Negotiating`,
   * awaiting the peer's XID response / FRMR / a TM201 retry). The listener /
   * harness uses this to decide whether an inbound XID/FRMR belongs to the MDL
   * or the data-link session.
   */
  get isNegotiating(): boolean {
    return this.driver.currentState === "Negotiating";
  }

  /**
   * Register a callback invoked when the MDL machine raises a Layer-3 signal —
   * `MDL-NEGOTIATE Confirm` or `MDL-ERROR Indicate (B/C/D)`. Subscribers run
   * synchronously on the posting path; keep handlers fast.
   */
  onMdlSignal(callback: (signal: MdlSignal) => void): void {
    this.mdlSignalListeners.push(callback);
  }

  /**
   * Start a negotiation — posts `MDL-NEGOTIATE Request`, which (from `Ready`)
   * sends the XID command, starts TM201, and moves to `Negotiating`. This is
   * the handler the data-link side's `MDL-NEGOTIATE Request` poke maps to.
   */
  negotiate(): void {
    this.driver.postEvent({ name: "MDL_NEGOTIATE_request" });
  }

  /**
   * Feed an inbound XID frame to the MDL machine. Routed as an
   * `XID_response_received` event — the MDL `Negotiating` state reacts only to
   * the XID *response* (§C5.3); an XID frame arriving in `Ready` (no command
   * outstanding) is the error-B "unexpected XID response" path. The listener /
   * harness hands the frame here when the MDL owns the exchange.
   */
  onXidReceived(frame: Ax25Frame): void {
    this.driver.postEvent({ name: "XID_response_received", frame });
  }

  /**
   * Feed an inbound FRMR frame to the MDL machine (figc5.2 t02): a pre-v2.2
   * peer rejecting our XID command. From `Negotiating` this triggers the §6.3.2
   * ¶1 version-2.0 fallback. A FRMR arriving in `Ready` (no command outstanding)
   * has no MDL transition and is ignored.
   */
  onFrmrReceived(frame: Ax25Frame): void {
    this.driver.postEvent({ name: "FRMR_received", frame });
  }

  /**
   * Handle an inbound XID *command* as the **responder**: merge the command's
   * offered parameters with our own offer per §6.3.2, apply the agreed values
   * to our link context, and reply with an XID *response* (F=1) carrying those
   * agreed values. A v2.2 connection is thereby made on both sides.
   *
   * **This is the un-transcribed figc5.1 path.** The prose-bootstrap MDL
   * machine encodes only the *initiator* side; the XID-*command*-reception
   * column of figc5.1 — the responder generating the XID response — is
   * explicitly NOT transcribed (the YAML header flags it as figure detail
   * awaiting the figc5.x backfill). So this responder behaviour cannot be driven
   * from the generated tables; it is implemented directly here, deriving the
   * response from the same normative §6.3.2 reverts-to rules
   * ({@link xid-negotiator}) the initiator applies. When figc5.1 is redrawn this
   * should move onto the SDL. Mirrors the C#
   * `Ax25ManagementDataLink.RespondToXidCommand`.
   *
   * Per §6.3.2 ¶7 the responder "chooses to accept the values offered, or other
   * acceptable values, and places these values in the XID response." We place
   * the *agreed* (post-merge) values, which is the strongest form of
   * "acceptable values" and guarantees both stations converge on the identical
   * reverts-to result.
   */
  respondToXidCommand(command: Ax25Frame): void {
    const parsed = tryParseXid(command.info);
    const commandParams: XidParameters = parsed.ok ? parsed.parameters : {};

    // Apply the §6.3.2 merge to our link context (our offer vs theirs).
    applyNegotiated(this.linkContext, this.offered, commandParams);

    // Echo the agreed values back in the response so the initiator's merge (its
    // offer vs our response) lands on the identical result.
    const agreed = Ax25ManagementDataLink.defaultOfferFor(this.linkContext);
    this.sendFrame(
      buildXid({
        destination: this.mdlContext.remote,
        source: this.mdlContext.local,
        info: encodeXid(agreed),
        isCommand: false,
        pollFinal: true, // F=1 — the initiator's figc5.2 F_eq_1 diamond requires it
      }),
    );
  }

  private buildXidCommand(): Ax25Frame {
    return buildXid({
      destination: this.mdlContext.remote,
      source: this.mdlContext.local,
      info: encodeXid(this.offered),
      isCommand: true,
      pollFinal: true, // error A ("XID command without P=1", §C5.3) implies P=1
    });
  }

  private onApplyNegotiatedParameters(tx: TransitionContext): void {
    // The triggering frame is the peer's XID response; parse its info field. A
    // malformed / empty info field means "no parameters offered" → the merge
    // falls through to the spec defaults per field (§4.3.3.7 ¶1024).
    const frame = tx.event.frame;
    let response: XidParameters = {};
    if (frame !== undefined) {
      const parsed = tryParseXid(frame.info);
      if (parsed.ok) response = parsed.parameters;
    }
    applyNegotiated(this.linkContext, this.offered, response);
  }

  private emitMdlSignal(signal: MdlSignal): void {
    for (const cb of this.mdlSignalListeners) cb(signal);
  }

  /**
   * Derive a sensible offered XID parameter set from a session context — our
   * current modulo / SREJ capability, window k, N1, T1, N2. Used when the caller
   * doesn't supply an explicit offer. We advertise our capability (mod-128 +
   * SREJ when the context is extended / SREJ-enabled) so the §6.3.2 merge can
   * revert to the lesser against the peer. Mirrors the C#
   * `Ax25ManagementDataLink.DefaultOfferFor`.
   */
  static defaultOfferFor(context: Ax25SessionContext): XidParameters {
    const reject: RejectMode = context.srejEnabled ? "selective" : "implicit";
    return {
      classesOfProcedures: context.halfDuplex
        ? CLASSES_OF_PROCEDURES_HALF_DUPLEX
        : CLASSES_OF_PROCEDURES_FULL_DUPLEX,
      hdlcOptionalFunctions: {
        reject,
        modulo128: context.isExtended,
        srejMultiframe: false,
        segmenterReassembler: context.segmenterReassemblerEnabled,
      },
      iFieldLengthRxBits: octetsToBits(context.n1),
      windowSizeRx: context.k,
      ackTimerMillis: context.t1vMs,
      retries: context.n2,
    };
  }
}
