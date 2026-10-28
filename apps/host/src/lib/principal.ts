/** Who a tunneled request or channel was authorized as: the access key it presented. */
export interface Principal {
  keyId: string
  name: string
}

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
