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
  test('loads null from a missing file, saves only the flag atomically, and still reads the old addresses', () => {
    const repository = new RemoteAccessRepository(file)
    expect(repository.load()).toBeNull()

    repository.save({ enabled: true })
    repository.save({ enabled: false })
    expect(repository.load()).toEqual({ enabled: false })
    expect(readdirSync(join(dir, 'data'))).toEqual(['remote-access.json'])

    const old = { enabled: true, serverUrl: 'wss://relay.example.com', clientUrl: null }
    writeFileSync(file, JSON.stringify(old))
    expect(repository.load()).toEqual(old)
  })

  test('a file that fails the schema throws and is left as it is', () => {
    const repository = new RemoteAccessRepository(file)
    repository.save({ enabled: true })
    for (const content of ['not json', JSON.stringify({ enabled: 'yes', serverUrl: null, clientUrl: null })]) {
      writeFileSync(file, content)
      expect(() => repository.load()).toThrow('not valid')
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
