const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']

/**
 * True when a request's `Host` header names this machine's loopback address and
 * the port the host listens on: `127.0.0.1:<port>`, `localhost:<port>` or
 * `[::1]:<port>`, the name in any case. The port must be explicit, since the
 * host never runs on a browser's default port.
 */
export function localHost(host: string | null | undefined, port: number): boolean {
  if (!host || !Number.isInteger(port) || port <= 0) return false
  const value = host.toLowerCase()
  return LOOPBACK_NAMES.some((name) => value === `${name}:${port}`)
}
