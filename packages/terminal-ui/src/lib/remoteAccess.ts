import type { TunnelState } from '@orch/shared'
import type { RemoteAccessTone } from '@orch/ui'

/** What the Remote access dialog says after a disconnect the server didn't record. */
export const REMOVE_IN_CLIENT =
  "Disconnected. The server did not remove this machine from your account's list: remove it in the client."

/**
 * What the Remote access dialog says about the connection, and the colour of
 * its dot, from the tunnel's state and whether an account is `linked`. A
 * tunnel that opens before the account is saved, as Connect does, reads as
 * connecting; a linked machine whose tunnel stopped has lost its connection.
 */
export function remoteAccessLabel(state: TunnelState, linked: boolean): { label: string; tone: RemoteAccessTone } {
  if (state === 'reconnecting') return { label: 'Reconnecting…', tone: 'warn' }
  if (state === 'connecting' || (state === 'connected' && !linked)) return { label: 'Connecting…', tone: 'warn' }
  if (!linked) return { label: 'Not connected', tone: 'off' }
  if (state === 'connected') return { label: 'Connected', tone: 'good' }
  return { label: 'Connection lost', tone: 'bad' }
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
