import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_REASONS, AGENT_STATES } from '@orch/agents/runtime'
import {
  buildId,
  DaemonDecoder,
  daemonStatus,
  embeddedBuildId,
  encodeControlFrame,
  encodeOutputFrame,
} from './daemon-protocol'

const dirs: string[] = []
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
  agentReport: null,
}
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

test('a daemon status may carry its start time, and carries the last report in the standard status', () => {
  expect(daemonStatus.parse({ ...status, startedAt: 1_700_000_000_000 }).startedAt).toBe(1_700_000_000_000)
  expect(daemonStatus.parse(status).agentReport).toBeNull()
  for (const state of AGENT_STATES) {
    for (const reason of AGENT_REASONS) {
      const agentReport = { state, reason, at: 5 }
      expect(daemonStatus.parse({ ...status, agentReport }).agentReport).toEqual(agentReport)
    }
  }
  expect(daemonStatus.safeParse({ ...status, agentReport: { state: 'working', reason: 'tool', at: 5 } }).success).toBe(
    false,
  )
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

  const agents = mkdtempSync(join(tmpdir(), 'orch-agent-build-'))
  dirs.push(agents)
  mkdirSync(join(agents, 'codex'), { recursive: true })
  writeFileSync(join(agents, 'codex', 'tracking.ts'), 'track()')
  const nested = buildId(null, dir, [agents])
  writeFileSync(join(agents, 'codex', 'tracking.test.ts'), 'test()')
  expect(buildId(null, dir, [agents])).toBe(nested)
  writeFileSync(join(agents, 'codex', 'tracking.ts'), 'track(again)')
  expect(buildId(null, dir, [agents])).not.toBe(nested)
})
