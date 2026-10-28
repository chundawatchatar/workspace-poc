import { HOST_PORT } from '@orch/shared'

/** True for requests from pages served on this machine, and for requests with no origin (curl, the CLI). */
export function localOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** The origin tunneled requests and sockets are addressed to, as if they came straight to the host. */
export const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`
