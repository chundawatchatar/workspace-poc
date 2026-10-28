import { describe, expect, test } from 'bun:test'
import { remoteAccessLabel, requestErrorMessage } from './remoteAccess'

describe('remoteAccessLabel', () => {
  test('names each tunnel state and colours it by how well it is going', () => {
    expect(remoteAccessLabel('off')).toEqual({ label: 'Off', tone: 'off' })
    expect(remoteAccessLabel('connecting')).toEqual({ label: 'Connecting…', tone: 'warn' })
    expect(remoteAccessLabel('connected')).toEqual({ label: 'Connected', tone: 'good' })
    expect(remoteAccessLabel('reconnecting')).toEqual({ label: 'Reconnecting…', tone: 'warn' })
    expect(remoteAccessLabel('stopped')).toMatchObject({ label: expect.stringContaining('Stopped'), tone: 'bad' })
  })
})

describe('requestErrorMessage', () => {
  test("shows the host's reason, and an unreachable host when there is none", () => {
    const failed = (rest: string) => new Error(`POST /api/remote-access/settings failed with ${rest}`)
    expect(requestErrorMessage(failed('400: The client address must be an http:// or https:// URL'))).toBe(
      'The client address must be an http:// or https:// URL',
    )
    expect(requestErrorMessage(failed('400: {"error":"✖ Invalid input"}'))).toBe('✖ Invalid input')
    expect(requestErrorMessage(failed('500'))).toBe('The host answered 500.')
    expect(requestErrorMessage(new TypeError('fetch failed'))).toBe('Could not reach the host.')
  })
})
