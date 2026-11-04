/** True for requests from pages served on this machine, and for requests with no origin (curl, the CLI). */
export function localOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * The base tunneled request and socket paths are parsed against, as if they came straight to the host. Nothing
 * connects to it, so it is not the host's address and needs no setting.
 */
export const HOST_ORIGIN = 'http://localhost'
