import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildId,
  DaemonDecoder,
  daemonStatus,
  embeddedBuildId,
  encodeControlFrame,
  encodeOutputFrame,
} from './daemon-protocol'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('decodes fragmented and coalesced frames, keeping control and output apart', () => {
  const decoder = new DaemonDecoder()
  const control = encodeControlFrame({ type: 'input', data: '中文 😀' })
  const output = encodeOutputFrame(new Uint8Array([0, 1, 2, 255]))
  expect(decoder.push(control.subarray(0, 3))).toEqual([])
  expect(decoder.push(control.subarray(3, control.length - 1))).toEqual([])
  const frames = decoder.push(Buffer.concat([control.subarray(-1), output]))
  expect(frames[0]).toEqual({ kind: 'control', value: { type: 'input', data: '中文 😀' } })
  expect(frames[1]?.kind).toBe('output')
  if (frames[1]?.kind === 'output') expect(Buffer.from(frames[1].bytes)).toEqual(Buffer.from([0, 1, 2, 255]))
})

test('rejects unbounded or empty daemon frames before buffering their payload', () => {
  for (const length of [0, 16 * 1024 * 1024 + 1, 0xffffffff]) {
    const header = Buffer.alloc(5)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(length, 1)
    expect(() => new DaemonDecoder().push(header)).toThrow('Invalid terminal daemon frame length')
  }
})

test('a daemon status may carry its start time, and one from an older daemon without it still parses', () => {
  const status = {
    protocol: 1,
    id: 'tab',
    instance: 'a'.repeat(32),
    daemonPid: 10,
    pid: 11,
    alive: true,
    title: 'zsh',
    attention: null,
    progress: null,
    cols: 80,
    rows: 24,
  }
  expect(daemonStatus.parse({ ...status, startedAt: 1_700_000_000_000 }).startedAt).toBe(1_700_000_000_000)
  expect(daemonStatus.parse(status).startedAt).toBeUndefined()
  expect(daemonStatus.parse(status).agentHook).toBeUndefined()
  const agentHook = { agent: 'claude', state: 'working', reason: 'tool', at: 5 }
  expect(daemonStatus.parse({ ...status, agentHook }).agentHook).toEqual(agentHook as never)
  expect(daemonStatus.parse({ ...status, agentHook: null }).agentHook).toBeNull()
})

test('an embedded build id reads no file; from source the id hashes the non-test sources', () => {
  expect(buildId('abc', '/nonexistent/orch-build')).toBe('abc')
  // Nothing defines `ORCH_BUILD_ID` under `bun test`.
  expect(embeddedBuildId()).toBeNull()

  const dir = mkdtempSync(join(tmpdir(), 'orch-build-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'main.ts'), 'run()')
  writeFileSync(join(dir, 'main.test.ts'), 'test()')
  const first = buildId(null, dir)
  expect(first).toMatch(/^[a-f0-9]{16}$/)

  writeFileSync(join(dir, 'main.test.ts'), 'test(again)')
  expect(buildId(null, dir)).toBe(first)
  writeFileSync(join(dir, 'main.ts'), 'run(again)')
  expect(buildId(null, dir)).not.toBe(first)
})
