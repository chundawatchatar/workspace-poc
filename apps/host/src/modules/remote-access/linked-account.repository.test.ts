import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinkedAccountRepository } from './linked-account.repository'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-linked-'))
  file = join(dir, 'data', 'linked-account.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const account = {
  name: 'Ada',
  maskedEmail: 'a***@example.com',
  serverUrl: 'wss://relay.example.com',
  linkedAt: '2026-11-04T12:00:00.000Z',
}

describe('LinkedAccountRepository', () => {
  test('loads null from a missing file, saves only the account atomically, and remove deletes it', () => {
    const repository = new LinkedAccountRepository(file)
    expect(repository.load()).toBeNull()

    repository.save({ ...account, key: 'oek_never' } as typeof account)
    expect(repository.load()).toEqual(account)
    expect(readFileSync(file, 'utf8')).not.toContain('oek_never')
    expect(readdirSync(join(dir, 'data'))).toEqual(['linked-account.json'])

    repository.remove()
    expect(existsSync(file)).toBe(false)
    repository.remove()
  })

  test('a file that fails the schema throws and is left as it is', () => {
    const repository = new LinkedAccountRepository(file)
    repository.save(account)
    for (const content of ['not json', JSON.stringify({ ...account, linkedAt: 'yesterday' })]) {
      writeFileSync(file, content)
      expect(() => repository.load()).toThrow('not valid')
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
