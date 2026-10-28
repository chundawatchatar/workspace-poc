import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteAccessRepository } from './remote-access.repository'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-remote-'))
  file = join(dir, 'data', 'remote-access.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('RemoteAccessRepository', () => {
  test('loads null from a missing file, and saves atomically', () => {
    const repository = new RemoteAccessRepository(file)
    expect(repository.load()).toBeNull()

    repository.save({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    repository.save({ enabled: false, serverUrl: 'wss://relay.example.com', clientUrl: 'https://orch.example' })
    expect(repository.load()).toEqual({
      enabled: false,
      serverUrl: 'wss://relay.example.com',
      clientUrl: 'https://orch.example',
    })
    expect(readdirSync(join(dir, 'data'))).toEqual(['remote-access.json'])
  })

  test('a file that fails the schema throws and is left as it is', () => {
    const repository = new RemoteAccessRepository(file)
    repository.save({ enabled: true, serverUrl: null, clientUrl: null })
    for (const content of ['not json', JSON.stringify({ enabled: 'yes', serverUrl: null, clientUrl: null })]) {
      writeFileSync(file, content)
      expect(() => repository.load()).toThrow('not valid')
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
