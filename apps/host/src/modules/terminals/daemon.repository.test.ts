import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonRepository } from './daemon.repository'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('retains credentials across host instances and never uses terminal ids as paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-record-'))
  roots.push(root)
  const repository = new DaemonRepository(root)
  roots.push(repository.runtime)
  const record = repository.get('../terminal/中文')
  expect(new DaemonRepository(root).get(record.id)).toEqual(record)
  expect(Buffer.byteLength(record.socket)).toBeLessThanOrEqual(100)
  expect(repository.list()).toEqual([record])
  const folder = join(root, '.data', 'terminal-daemons')
  expect(JSON.parse(readFileSync(join(folder, readdirSync(folder).at(0) ?? ''), 'utf8'))).toEqual(record)
  repository.remove(record.id)
  expect(repository.list()).toEqual([])
})

test('refuses a credentials directory accessible to other users', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-record-'))
  roots.push(root)
  const repository = new DaemonRepository(root)
  roots.push(repository.runtime)
  chmodSync(join(root, '.data', 'terminal-daemons'), 0o755)
  expect(() => new DaemonRepository(root)).toThrow('must be private')
})
