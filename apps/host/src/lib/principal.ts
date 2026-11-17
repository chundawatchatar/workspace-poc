/**
 * Who a tunneled request or channel was authorized as: the account this
 * machine is linked to, as the server said, through `deviceId`, a browser
 * approved on this machine. `ticketExp` is the `exp` of the relay ticket that
 * admitted it, in epoch seconds, so what it opens can end with that ticket.
 */
export type Principal = { kind: 'account'; accountId: string; deviceId: string; ticketExp: number }

// A symbol, so no header or env a caller controls can claim to be tunneled.
// Local requests get Bun's server as their env, which never has it.
const PRINCIPAL = Symbol('principal')

/** The Hono env the tunnel passes to `app.fetch` for a request it authorized. */
export function tunnelEnv(principal: Principal): Record<symbol, Principal> {
  return { [PRINCIPAL]: principal }
}

/** The principal of a request the tunnel authorized, or null for local traffic. */
export function tunnelPrincipal(env: unknown): Principal | null {
  if (typeof env !== 'object' || env === null) return null
  return (env as Record<symbol, Principal | undefined>)[PRINCIPAL] ?? null
}
