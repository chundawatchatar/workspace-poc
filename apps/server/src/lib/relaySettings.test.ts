import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { rootEnvPath } from '@orch/shared/env'
import { loadRelaySettings } from './relaySettings'

const env = {
  SERVER_MAX_CHANNELS: '64',
  SERVER_REQUEST_TIMEOUT_MS: '5000',
  SERVER_STATIC_DIR: 'apps/client/dist',
}

describe('loadRelaySettings', () => {
  test('reads the numbers and resolves a relative static folder from the repo root', () => {
    expect(loadRelaySettings(env)).toEqual({
      maxChannelsPerMachine: 64,
      requestTimeoutMs: 5000,
      staticDir: join(dirname(rootEnvPath), 'apps/client/dist'),
      allowedOrigins: [],
      trustProxy: false,
    })
  })

  test('keeps an absolute static folder and reads the optional settings', () => {
    const settings = loadRelaySettings({
      ...env,
      SERVER_STATIC_DIR: '/srv/client',
      SERVER_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      SERVER_TRUST_PROXY: '1',
    })
    expect(settings.staticDir).toBe('/srv/client')
    expect(settings.allowedOrigins).toEqual(['https://a.example', 'https://b.example'])
    expect(settings.trustProxy).toBe(true)
  })

  test.each([undefined, '  '])('names a missing or blank required setting (%p)', (value) => {
    for (const key of Object.keys(env)) {
      expect(() => loadRelaySettings({ ...env, [key]: value })).toThrow(key)
    }
  })

  test.each(['abc', '0', '-1', '1.5'])(
    'names a number setting that is not a positive integer, never its value (%p)',
    (bad) => {
      expect(() => loadRelaySettings({ ...env, SERVER_MAX_CHANNELS: bad })).toThrow(
        'SERVER_MAX_CHANNELS must be a positive integer.',
      )
    },
  )
})
