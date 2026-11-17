import { describe, expect, test } from 'bun:test'
import { DEFAULT_SERVER_URL, loadSettings, type Settings, SettingsError, type SettingsInput } from './settings.service'

const none = { flags: {}, env: {}, file: null }

describe('loadSettings', () => {
  test('with nothing set, every setting is its default, and CORCH_CLIENT_URL is not read', () => {
    const defaults: Settings = {
      port: { value: 4599, source: 'default', setBy: null },
      relayUrl: { value: DEFAULT_SERVER_URL, source: 'default', setBy: null },
      logLevel: { value: 'info', source: 'default', setBy: null },
    }
    expect(loadSettings(none)).toEqual(defaults)
    expect(loadSettings({ ...none, env: { CORCH_CLIENT_URL: 'https://app.example.com' } })).toEqual(defaults)
  })

  test('a flag beats CORCH_<NAME>, which beats the file, which beats the default, key by key', () => {
    const file = { port: 4700, relayUrl: 'wss://file.example.com', logLevel: 'warn' }
    const env = { CORCH_PORT: '4800', CORCH_RELAY_URL: 'wss://env.example.com', CORCH_LOG_LEVEL: '' }
    const flags = { '--port': '4900' }

    expect(loadSettings({ flags, env, file })).toMatchObject({
      port: { value: 4900, source: 'flag', setBy: '--port' },
      relayUrl: { value: 'wss://env.example.com', source: 'env', setBy: 'CORCH_RELAY_URL' },
      // An empty variable counts as unset, so the file's value is used.
      logLevel: { value: 'warn', source: 'file', setBy: null },
    })
    expect(loadSettings({ flags: {}, env, file }).port).toEqual({ value: 4800, source: 'env', setBy: 'CORCH_PORT' })
    expect(loadSettings({ flags: {}, env: {}, file }).port).toEqual({ value: 4700, source: 'file', setBy: null })
    expect(
      loadSettings({ ...none, defaults: { port: 1, relayUrl: 'ws://127.0.0.1:1', logLevel: 'error' } }),
    ).toMatchObject({ port: { value: 1, source: 'default' }, logLevel: { value: 'error', source: 'default' } })
  })

  test('a bad value or an unknown key throws a SettingsError naming the key and where it came from', () => {
    const cases: [Partial<SettingsInput>, string][] = [
      [{ env: { CORCH_PORT: 'abc' } }, 'CORCH_PORT (port) must be a whole number from 1 to 65535'],
      [{ flags: { '--relay-url': 'ws://example.com' } }, '--relay-url (relayUrl) must be wss://<host>'],
      [{ file: { port: 0 } }, 'config.json: port must be a whole number from 1 to 65535'],
      [{ file: { relayUrl: 'https://x' } }, 'config.json: relayUrl must be wss://<host>'],
      [{ file: { logLevel: 'loud' } }, 'config.json: logLevel must be one of error, warn, info, debug'],
      [{ file: { prot: 4599 } }, 'config.json: prot is not a setting'],
      [{ file: [] }, 'config.json must hold a JSON object'],
    ]
    for (const [input, message] of cases) {
      const load = () => loadSettings({ ...none, ...input })
      expect(load).toThrow(SettingsError)
      expect(load).toThrow(message)
    }
  })
})
