import { describe, expect, test } from 'bun:test'
import { remoteAccessLabel, requestErrorMessage } from './remoteAccess'

describe('remoteAccessLabel', () => {
  test('names the connection from the tunnel and the account, and colours it by how well it is going', () => {
    const label = (state: Parameters<typeof remoteAccessLabel>[0], linked: boolean) =>
      remoteAccessLabel(state, linked).label
    expect(remoteAccessLabel('off', false)).toEqual({ label: 'Not connected', tone: 'off' })
    expect(label('stopped', false)).toBe('Not connected')
    expect(remoteAccessLabel('connecting', false)).toEqual({ label: 'Connecting…', tone: 'warn' })
    // Connect opens the tunnel before the key is redeemed.
    expect(label('connected', false)).toBe('Connecting…')
    expect(label('connecting', true)).toBe('Connecting…')
    expect(remoteAccessLabel('connected', true)).toEqual({ label: 'Connected', tone: 'good' })
    expect(remoteAccessLabel('reconnecting', true)).toEqual({ label: 'Reconnecting…', tone: 'warn' })
    expect(remoteAccessLabel('stopped', true)).toEqual({ label: 'Connection lost', tone: 'bad' })
    expect(label('off', true)).toBe('Connection lost')
    // A Connect waiting for the owner's answer says so, until it links.
    expect(remoteAccessLabel('connected', false, true)).toEqual({ label: 'Waiting for approval…', tone: 'warn' })
    expect(remoteAccessLabel('connected', true, true).label).toBe('Connected')
  })
})

describe('requestErrorMessage', () => {
  test("shows the host's reason, and an unreachable host when there is none", () => {
    const failed = (rest: string) => new Error(`POST /api/remote-access/connect failed with ${rest}`)
    expect(requestErrorMessage(failed('409: This machine is already connected. Disconnect it first'))).toBe(
      'This machine is already connected. Disconnect it first',
    )
    expect(requestErrorMessage(failed('400: {"error":"✖ Invalid input"}'))).toBe('✖ Invalid input')
    expect(requestErrorMessage(failed('500'))).toBe('The host answered 500.')
    expect(requestErrorMessage(new TypeError('fetch failed'))).toBe('Could not reach the host.')
  })
})
