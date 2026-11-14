import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkedAccountPath } from '../remote-access/linked-account.repository'
import { remoteAccessPath } from '../remote-access/remote-access.repository'
import { migrateRemoteAccessAddresses, readSettingsFile, saveAddresses, settingsPath } from './settings.repository'
import { SettingsError } from './settings.service'

let dir: string
const config = () => settingsPath(dir)
const remote = () => remoteAccessPath(dir)
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
/** Every file in the folder with its exact contents. */
const snapshot = () => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-settings-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('settings file', () => {
  test('reads null for a missing file and refuses one that is not JSON, naming it', () => {
    expect(config()).toBe(join(dir, 'config.json'))
    expect(readSettingsFile(config())).toBeNull()
    writeFileSync(config(), '{ "port": ')
    expect(() => readSettingsFile(config())).toThrow(SettingsError)
    expect(() => readSettingsFile(config())).toThrow(`${config()} is not valid JSON`)
  })

  test('saveAddresses sets or removes only the addresses, keeps every other key, and never writes over a bad file', () => {
    saveAddresses(config(), { relayUrl: 'wss://relay.example.com' })
    expect(readJson(config())).toEqual({ relayUrl: 'wss://relay.example.com' })

    writeFileSync(config(), JSON.stringify({ port: 4700, relayUrl: 'wss://a.example.com', clientUrl: 'https://c' }))
    saveAddresses(config(), { relayUrl: 'wss://b.example.com', clientUrl: null })
    expect(readJson(config())).toEqual({ port: 4700, relayUrl: 'wss://b.example.com' })
    expect(readdirSync(dir)).toEqual(['config.json'])

    writeFileSync(config(), '[1')
    expect(() => saveAddresses(config(), { relayUrl: 'wss://c.example.com' })).toThrow('is not valid JSON')
    expect(readFileSync(config(), 'utf8')).toBe('[1')
  })
})

describe('migrateRemoteAccessAddresses', () => {
  const old = { enabled: true, serverUrl: 'wss://relay.example.com', clientUrl: 'https://app.example.com' }

  test('moves the old addresses into config.json once, then leaves remote-access.json with its flag', () => {
    writeFileSync(remote(), JSON.stringify(old))
    writeFileSync(linkedAccountPath(dir), '{"name":"Ada"}')
    expect(migrateRemoteAccessAddresses(dir)).toBe(true)
    expect(readJson(config())).toEqual({ relayUrl: old.serverUrl, clientUrl: old.clientUrl })
    expect(readJson(remote())).toEqual({ enabled: true })

    const after = snapshot()
    expect(migrateRemoteAccessAddresses(dir)).toBe(false)
    expect(snapshot()).toEqual(after)
    expect(readFileSync(linkedAccountPath(dir), 'utf8')).toBe('{"name":"Ada"}')
  })

  test('keeps an address config.json already has, and moves an invalid old one as it is', () => {
    writeFileSync(config(), JSON.stringify({ relayUrl: 'wss://kept.example.com', logLevel: 'debug' }))
    writeFileSync(remote(), JSON.stringify({ ...old, enabled: false, clientUrl: 'not a url' }))
    migrateRemoteAccessAddresses(dir)
    expect(readJson(config())).toEqual({
      relayUrl: 'wss://kept.example.com',
      logLevel: 'debug',
      clientUrl: 'not a url',
    })
    expect(readJson(remote())).toEqual({ enabled: false })

    // A folder with no old addresses, or no remote-access.json at all, is left as it is.
    rmSync(config())
    expect(migrateRemoteAccessAddresses(dir)).toBe(false)
    rmSync(remote())
    expect(migrateRemoteAccessAddresses(dir)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  test('an unreadable config.json or remote-access.json throws and leaves both files byte for byte', () => {
    for (const [remoteText, configText] of [
      [JSON.stringify(old), '{ broken'],
      [JSON.stringify(old), '"a string"'],
      ['{ broken', JSON.stringify({ port: 4700 })],
      [JSON.stringify({ enabled: 'yes', serverUrl: 'wss://x' }), JSON.stringify({ port: 4700 })],
    ] as const) {
      writeFileSync(remote(), remoteText)
      writeFileSync(config(), configText)
      const before = snapshot()
      expect(() => migrateRemoteAccessAddresses(dir)).toThrow(/is not valid|must hold a JSON object/)
      expect(snapshot()).toEqual(before)
    }
    expect(existsSync(linkedAccountPath(dir))).toBe(false)
  })
})
