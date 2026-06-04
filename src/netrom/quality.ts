/**
 * NET/ROM route-quality arithmetic — the multiplicative per-hop decay from the
 * canonical NET/ROM appendix. Quality is an integer 0 (worst) … 255 (best).
 *
 * When node A hears node B advertise destination D at quality `bq`, A's quality
 * for the route to D *via B* is the advertised quality scaled by A's own path
 * quality to B:
 * ```
 *   routequality = (broadcastquality × pathquality + 128) / 256   (integer, rounded)
 * ```
 * The `+ 128` is round-to-nearest on the divide-by-256. Quality therefore decays
 * multiplicatively with each hop: a 200-quality direct link is ≈ 156 at two hops
 * (200 × 200 / 256) and ≈ 78 at three (last link 128). The practical per-hop /
 * floor conventions (direct link ~192–203, MINQUAL ~128–180) are *de-facto, not
 * normative* — they vary per implementation, so they live as configurable knobs
 * on {@link NetRomRoutingOptions}, never hard-coded here.
 *
 * Mirrors `Packet.NetRom.Routing.NetRomQuality` on the C# side.
 */

/** The maximum (best) quality value. */
export const NETROM_QUALITY_MAX = 255;

/** The minimum (worst) quality value — a quality-0 route is never usable / re-advertised. */
export const NETROM_QUALITY_MIN = 0;

/**
 * Combine an advertised broadcast quality with the path quality to the
 * advertising neighbour, per the canonical multiplicative formula
 * `(broadcastquality × pathquality + 128) / 256`, rounded and clamped to 0..255.
 *
 * @param broadcastQuality The quality the neighbour advertised for the destination (0..255).
 * @param pathQuality Our path quality to that neighbour (0..255).
 * @returns Our derived route quality for the destination via that neighbour (0..255).
 */
export function combineQuality(
  broadcastQuality: number,
  pathQuality: number,
): number {
  // (a × b + 128) / 256, integer (floor of the non-negative quotient — the C#
  // integer divide). Max input 255 × 255 + 128 = 65153, result ≤ 254 so it
  // always fits a byte, but clamp for total safety.
  const combined = Math.floor((broadcastQuality * pathQuality + 128) / 256);
  return Math.max(NETROM_QUALITY_MIN, Math.min(NETROM_QUALITY_MAX, combined));
}
