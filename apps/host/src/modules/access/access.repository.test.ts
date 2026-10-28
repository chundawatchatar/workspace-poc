import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AccessKey, AccessKeyRepository } from './access.repository'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-access-'))
  file = join(dir, 'data', 'access-keys.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const key: AccessKey = {
  id: 'id-1',
  name: 'default',
  hash: 'h'.repeat(43),
  createdAt: '2026-10-28T12:00:00.000Z',
  lastUsedAt: null,
}

describe('AccessKeyRepository', () => {
  test('loads no keys from a missing file, and saves atomically in mode 0600', () => {
    const repository = new AccessKeyRepository(file)
    expect(repository.load()).toEqual([])

    repository.save([key])
    repository.save([key, { ...key, id: 'id-2' }])
    expect(repository.load()).toHaveLength(2)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'data'))).toEqual(['access-keys.json'])
  })

  test('a file that fails the schema throws without quoting it, and is left as it is', () => {
    const repository = new AccessKeyRepository(file)
    repository.save([key])
    const secretish = 'x'.repeat(43)
    for (const content of [`not json ${secretish}`, JSON.stringify({ keys: [{ ...key, hash: secretish, id: '' }] })]) {
      writeFileSync(file, content)
      let message = ''
      try {
        repository.load()
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('not valid')
      expect(message).not.toContain(secretish)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
