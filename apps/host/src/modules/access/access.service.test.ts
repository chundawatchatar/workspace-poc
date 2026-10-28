import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConnectFragment } from '@orch/shared'
import { type AccessKey, AccessKeyRepository } from './access.repository'
import {
  AccessKeys,
  clientUrlFromServerUrl,
  connectLink,
  machineIdFromSecret,
  parseClientUrl,
  rotateAccess,
} from './access.service'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-access-'))
  file = join(dir, 'access-keys.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const stored = () => JSON.parse(readFileSync(file, 'utf8')) as { keys: AccessKey[] }
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')

describe('AccessKeys', () => {
  test('create stores only the hash of a 32-byte key, in a file only this user can read', () => {
    const keys = new AccessKeys(new AccessKeyRepository(file))
    const key = keys.create('default')

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(key, 'base64url')).toHaveLength(32)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain(key)
    const [entry] = stored().keys
    expect(entry).toEqual({
      id: expect.any(String),
      name: 'default',
      hash: sha256(key),
      createdAt: expect.any(String),
      lastUsedAt: null,
    })
    expect(new Date(String(entry?.createdAt)).toISOString()).toBe(String(entry?.createdAt))
    expect(new AccessKeys(new AccessKeyRepository(file)).size).toBe(1)
  })

  test('authorize finds the matching key among several and refuses missing, empty, wrong and wrong-length keys', () => {
    const keys = new AccessKeys(new AccessKeyRepository(file))
    const created = ['one', 'two', 'three'].map((name) => ({ name, key: keys.create(name) }))
    const ids = stored().keys.map((entry) => entry.id)

    for (const [i, { name, key }] of created.entries()) expect(keys.authorize(key)).toEqual({ keyId: ids[i], name })
    const wrong = `${created[1]?.key.slice(0, -1)}${created[1]?.key.endsWith('A') ? 'B' : 'A'}`
    for (const bad of [null, '', wrong, 'short', `${created[0]?.key}x`]) expect(keys.authorize(bad)).toBeNull()
  })

  test('a match records lastUsedAt in memory, and writes it only after the persist interval or on flush', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z')
    const keys = new AccessKeys(new AccessKeyRepository(file), { now: () => now, persistEveryMs: 40 })
    const key = keys.create('default')
    keys.authorize(key)
    keys.authorize(key)
    expect(stored().keys[0]?.lastUsedAt).toBeNull()

    await Bun.sleep(80)
    expect(stored().keys[0]?.lastUsedAt).toBe(now.toISOString())

    now.setTime(now.getTime() + 1000)
    keys.authorize(key)
    keys.flush()
    expect(stored().keys[0]?.lastUsedAt).toBe(now.toISOString())
  })

  test('rotate replaces every key with a new default key and reports the revoked ids', () => {
    let revoked: string[] = []
    const keys = new AccessKeys(new AccessKeyRepository(file), { onRevoked: (ids) => (revoked = ids) })
    const old = [keys.create('default'), keys.create('laptop')]
    const oldIds = stored().keys.map((entry) => entry.id)

    const result = rotateAccess({ keys, machineId: 'm-1', clientUrl: 'https://orch.example/app/' })

    expect(revoked).toEqual(oldIds)
    expect(stored().keys).toEqual([expect.objectContaining({ name: 'default', hash: sha256(result.key) })])
    for (const key of old) expect(keys.authorize(key)).toBeNull()
    expect(keys.authorize(result.key)).toMatchObject({ name: 'default' })
    expect(result.link?.startsWith('https://orch.example/app/#')).toBe(true)
    expect(parseConnectFragment(new URL(result.link ?? '').hash)).toEqual({ machineId: 'm-1', key: result.key })
    expect(rotateAccess({ keys, machineId: 'm-1', clientUrl: null }).link).toBeNull()
  })
})

describe('connect links', () => {
  test('machineIdFromSecret matches the server derivation', () => {
    expect(machineIdFromSecret(`${'A'.repeat(42)}w`)).toBe('iaXQeq8zGWOVzmXZ8CSONVci1x_234c8R-Cjqm229fM')
  })

  test('the client URL is an http(s) CLIENT_URL, or SERVER_URL with ws(s) swapped for http(s)', () => {
    expect(parseClientUrl('https://orch.example/app/')).toBe('https://orch.example/app')
    expect(parseClientUrl('http://127.0.0.1:3220')).toBe('http://127.0.0.1:3220')
    for (const bad of ['ftp://orch.example', 'javascript:alert(1)', 'orch.example', 'https://u:p@orch.example']) {
      expect(parseClientUrl(bad)).toBeNull()
    }
    expect(clientUrlFromServerUrl('wss://relay.example.com:8443/base/')).toBe('https://relay.example.com:8443/base')
    expect(clientUrlFromServerUrl('ws://127.0.0.1:4600')).toBe('http://127.0.0.1:4600')
    expect(clientUrlFromServerUrl('https://relay.example.com')).toBeNull()
    expect(connectLink('http://127.0.0.1:4600', 'm', 'k')).toBe('http://127.0.0.1:4600/#machine=m&key=k')
  })
})
