import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonRepository, daemonRuntimeDir } from './daemon.repository'

const roots: string[] = []
const cwd = process.cwd()
const runtimeEnv = process.env.ORCH_PTY_RUNTIME
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  process.chdir(cwd)
  if (runtimeEnv === undefined) delete process.env.ORCH_PTY_RUNTIME
  else process.env.ORCH_PTY_RUNTIME = runtimeEnv
})

/** A temporary data folder and runtime folder, both removed after the test. */
function folders() {
  const dataDir = mkdtempSync(join(tmpdir(), 'orch-record-'))
  const runtime = mkdtempSync(join(tmpdir(), 'orch-rt-'))
  roots.push(dataDir, runtime)
  return { dataDir, runtime }
}

describe('daemonRuntimeDir', () => {
  test('keeps the folder a dev host used before the data folder was a setting', () => {
    const before = createHash('sha256').update(resolve('/repo/apps/host')).digest('hex').slice(0, 12)
    expect(daemonRuntimeDir('/repo/apps/host/.data', 501)).toBe(`/tmp/orchpty-501-${before}`)
    expect(daemonRuntimeDir('/repo/apps/host/.data/', 501)).toBe(`/tmp/orchpty-501-${before}`)
  })

  test('gives different data folders different runtime folders, a folder and its own .data included', () => {
    const folders = ['/srv/a', '/srv/b', '/srv/a/.data', '/Users/ana/.corch'].map((dir) => daemonRuntimeDir(dir, 501))
    expect(new Set(folders).size).toBe(4)
    expect(daemonRuntimeDir('/srv/a', 501)).not.toBe(daemonRuntimeDir('/srv/a', 502))
  })

  test('depends only on its arguments, not the working directory or the environment', () => {
    const first = daemonRuntimeDir('/srv/a', 501)
    process.chdir(tmpdir())
    process.env.ORCH_PTY_RUNTIME = '/tmp/elsewhere'
    expect(daemonRuntimeDir('/srv/a', 501)).toBe(first)
  })
})

test('keeps records in the data folder and the socket in the runtime folder it is given, whatever ORCH_PTY_RUNTIME says', () => {
  delete process.env.ORCH_PTY_RUNTIME
  const { dataDir, runtime } = folders()
  const repository = new DaemonRepository({ dataDir, runtime })
  expect(repository.socket).toBe(join(runtime, 'host.sock'))
  repository.get('term_1')
  expect(readdirSync(join(dataDir, 'terminal-daemons'))).toHaveLength(1)

  process.env.ORCH_PTY_RUNTIME = join(dataDir, 'other')
  const again = new DaemonRepository({ dataDir, runtime })
  expect(again.runtime).toBe(runtime)
  expect(again.socket).toBe(join(runtime, 'host.sock'))
  expect(again.list().map((record) => record.id)).toEqual(['term_1'])
  expect(readdirSync(dataDir)).toEqual(['terminal-daemons'])
})

test('retains credentials across host instances and never uses terminal ids as paths', () => {
  const options = folders()
  const repository = new DaemonRepository(options)
  const record = repository.get('../terminal/中文')
  expect(new DaemonRepository(options).get(record.id)).toEqual(record)
  expect(Buffer.byteLength(repository.socket)).toBeLessThanOrEqual(100)
  expect(repository.list()).toEqual([record])
  const folder = join(options.dataDir, 'terminal-daemons')
  expect(JSON.parse(readFileSync(join(folder, readdirSync(folder).at(0) ?? ''), 'utf8'))).toEqual(record)
  repository.remove(record.id)
  expect(repository.list()).toEqual([])
})

test('refuses a credentials directory accessible to other users', () => {
  const options = folders()
  new DaemonRepository(options)
  chmodSync(join(options.dataDir, 'terminal-daemons'), 0o755)
  expect(() => new DaemonRepository(options)).toThrow('must be private')
})

test('refuses a runtime folder whose socket path would be over 100 bytes', () => {
  const { dataDir } = folders()
  const fits = join(dataDir, 'r'.repeat(100 - dataDir.length - 'host.sock'.length - 2))
  expect(Buffer.byteLength(join(fits, 'host.sock'))).toBe(100)
  expect(() => new DaemonRepository({ dataDir, runtime: fits })).not.toThrow()
  expect(() => new DaemonRepository({ dataDir, runtime: `${fits}r` })).toThrow('over 100 bytes')
})

test('keeps where a terminal was and the agent it ran, and still reads records from before they existed', () => {
  const options = folders()
  const repository = new DaemonRepository(options)
  const { token } = repository.get('term_1')
  const folder = join(options.dataDir, 'terminal-daemons')
  const file = join(folder, readdirSync(folder).at(0) ?? '')
  writeFileSync(file, JSON.stringify({ id: 'term_1', token }))
  const agent = { kind: 'claude' as const, sessionId: 'abc', cwd: '/repo' }
  repository.update('term_1', { cwd: '/repo/sub', agent })
  expect(new DaemonRepository(options).get('term_1')).toEqual({ id: 'term_1', token, cwd: '/repo/sub', agent })
  repository.update('term_1', { agent: null })
  expect(repository.list()).toEqual([{ id: 'term_1', token, cwd: '/repo/sub', agent: null }])
  expect(readdirSync(folder)).toHaveLength(1)
})
