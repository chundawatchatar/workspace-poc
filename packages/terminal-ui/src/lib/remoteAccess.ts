import type { TunnelState } from '@orch/shared'
import type { RemoteAccessTone } from '@orch/ui'

/** What the Remote access dialog says about the tunnel, and the colour of its dot. */
export function remoteAccessLabel(state: TunnelState): { label: string; tone: RemoteAccessTone } {
  switch (state) {
    case 'off':
      return { label: 'Off', tone: 'off' }
    case 'connecting':
      return { label: 'Connecting…', tone: 'warn' }
    case 'connected':
      return { label: 'Connected', tone: 'good' }
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warn' }
    case 'stopped':
      return { label: 'Stopped: another host took over, or the server needs a newer host', tone: 'bad' }
  }
}

/**
 * The host's reason for refusing a request made with `callApi`, for showing to
 * the user. A request that never got an answer reads as the host being unreachable.
 */
export function requestErrorMessage(error: unknown): string {
  const match = error instanceof Error ? /failed with (\d+)(?:: ([\s\S]*))?$/.exec(error.message) : null
  if (!match) return 'Could not reach the host.'
  const detail = match[2]?.trim()
  if (!detail) return `The host answered ${match[1]}.`
  try {
    // A request that fails its schema gets `{ error }` as JSON.
    const parsed: unknown = JSON.parse(detail)
    if (typeof parsed === 'object' && parsed && 'error' in parsed && typeof parsed.error === 'string') {
      return parsed.error
    }
  } catch {}
  return detail
}
