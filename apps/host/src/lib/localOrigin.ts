/** True for requests from pages served on this machine, and for requests with no origin (curl, the CLI). */
export function localOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}
