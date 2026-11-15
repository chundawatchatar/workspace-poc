import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logTail, sendSignal } from './lifecycle'
import { logPath } from './log-writer'

let root: string | undefined
let sleeper: Bun.Subprocess | undefined
afterEach(async () => {
  if (root) rmSync(root, { recursive: true, force: true })
  sleeper?.kill()
  await sleeper?.exited
  root = undefined
  sleeper = undefined
})

describe('sendSignal', () => {
  test('counts a child that has already exited as signalled', async () => {
    const child = Bun.spawn(['true'])
    await child.exited
    expect(() => sendSignal(child.pid, 'SIGTERM')).not.toThrow()
  })

  test('throws any error other than ESRCH', () => {
    sleeper = Bun.spawn(['sleep', '30'])
    expect(() => sendSignal((sleeper as Bun.Subprocess).pid, 'SIGNOPE' as NodeJS.Signals)).toThrow()
  })

  test('is how start and stop send every signal', () => {
    const source = readFileSync(join(import.meta.dir, 'lifecycle.ts'), 'utf8')
    expect(source.match(/process\.kill\(/g)).toHaveLength(1)
    expect(source).toContain("sendSignal(child.pid, 'SIGTERM')")
    expect(source).toContain("sendSignal(child.pid, 'SIGKILL')")
    expect(source).toContain("sendSignal(pid, 'SIGTERM')")
  })
})

describe('logTail', () => {
  test('shows control characters as ? but keeps line breaks and tabs', () => {
    root = mkdtempSync(join(tmpdir(), 'corch-tail-'))
    writeFileSync(logPath(root), 'one\t\x1b[31mred\x1b[0m\r\nbell\x07 \x7f\u009b\n')
    const tail = logTail(root, 0) as string
    expect(tail).toEndWith('one\t?[31mred?[0m?\nbell? ??')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for control characters is the point.
    expect(tail).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  })
})
