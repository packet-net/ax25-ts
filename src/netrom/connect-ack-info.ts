/**
 * Codec for the information field of a NET/ROM L4 **Connect Acknowledge**
 * (opcode 0x02). The first octet, the **accepted send-window**, is base NET/ROM
 * and rides every acknowledgement; the acknowledging end reports the window it
 * settled on so the originator can bring its own send ceiling down to it.
 *
 * Wire layout (the vanilla, base-NET/ROM form), 1 octet at the front of the
 * Connect Acknowledge info field:
 * ```
 *   [1] accepted send-window size (1..127)
 * ```
 *
 * **The window octet is not an extension.** LinBPQ writes
 * `L3MSG->L4DATA[0] = L4->L4WINDOW` then sets `LENGTH = MSGHDDRLEN + 22`
 * (`L4Code.c:1768,1824`), a 21-byte vanilla Connect Acknowledge, and reads it
 * back unconditionally (`L4->L4WINDOW = L3MSG->L4DATA[0]`, `L4Code.c:2287`).
 * Linux `af_netrom` does the same: `nr_write_internal` emits `nr->window` with
 * `NR_CONNACK_LEN = 1` and the receive path reads `skb->data[20]`. A peer that
 * ignores the octet is unharmed; it is trailing info to it.
 *
 * **No compression form here.** LinBPQ adds a second octet (a time-to-live /
 * flags byte whose bit 0x80 is "compression agreed") when the Connect Request
 * came from a BPQ node. That 2-octet extension is C#-side only: this library has
 * no compression option at all (nothing in `src/netrom/` compresses), so there is
 * no agreement to mirror back and inventing an option here would be a divergence,
 * not parity. The reader below tolerates (and ignores) a longer field, so a peer
 * that sends the BPQ extension still negotiates its window with us correctly.
 *
 * Mirrors `Packet.NetRom.Wire.ConnectAckInfo` on the C# side (its `Build`
 * compression overload and `AgreesCompression` are the deliberate omissions
 * above).
 */

/**
 * Octets a vanilla (base NET/ROM) Connect Acknowledge info field occupies: the
 * accepted send-window alone. A peer may append extension octets after it.
 *
 * Mirrors the C# `ConnectAckInfo.VanillaLength`.
 */
export const CONNECT_ACK_INFO_VANILLA_LENGTH = 1;

/**
 * The largest window a peer may accept: the NET/ROM sequence space leaves bit 7
 * to the flags, so 127 is the ceiling, the same clamp the circuit applies to its
 * own proposal.
 *
 * Mirrors the C# `ConnectAckInfo.MaxWindow`.
 */
export const CONNECT_ACK_MAX_WINDOW = 127;

/**
 * Build the vanilla Connect Acknowledge info field: the accepted window octet,
 * and nothing else. This is the acknowledgement LinBPQ and Linux both emit.
 *
 * @param acceptedWindow The window this end settled on. Clamped to
 *   1..{@link CONNECT_ACK_MAX_WINDOW} so the octet is always readable by a peer
 *   applying the same sanity bound.
 *
 * Mirrors `ConnectAckInfo.Build` on the C# side (its vanilla,
 * `agreeCompression: false` path).
 */
export function buildConnectAckInfo(acceptedWindow: number): Uint8Array {
  const win = Math.max(
    1,
    Math.min(CONNECT_ACK_MAX_WINDOW, Math.trunc(acceptedWindow)),
  );
  return Uint8Array.from([win]);
}

/**
 * Read the accepted send-window an acknowledging peer reported. Returns `null`
 * (never throws) for an absent octet (a terse peer that sent no info field at
 * all) or an out-of-range value (0, or greater than
 * {@link CONNECT_ACK_MAX_WINDOW}, a peer that put something else there); the
 * originator then keeps the window it proposed. Trailing octets beyond the first
 * (a peer's BPQ TTL/compression extension) are ignored.
 *
 * Mirrors LinBPQ's unconditional `L4WINDOW = L4DATA[0]` (`L4Code.c:2287`) and
 * Linux's `skb->data[20]` read, with the sanity bound BPQ gets from its own
 * `L4DEFAULTWINDOW` fallback (`L4Code.c:2010-2013`).
 *
 * Mirrors `ConnectAckInfo.TryReadAcceptedWindow` on the C# side (which returns a
 * `bool` + `out` byte; TS returns the value or `null`, matching the
 * `tryParseConnectRequestInfo` convention).
 */
export function tryReadAcceptedWindow(info: Uint8Array): number | null {
  if (info.length < CONNECT_ACK_INFO_VANILLA_LENGTH) {
    return null;
  }
  const acceptedWindow = info[0]!;
  if (acceptedWindow === 0 || acceptedWindow > CONNECT_ACK_MAX_WINDOW) {
    return null;
  }
  return acceptedWindow;
}
