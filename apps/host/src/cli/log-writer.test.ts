import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CappedLog, logPath, previousLogPath } from './log-writer'
import { logsCommand, readLogs } from './logs'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('CappedLog', () => {
  test('moves the log to corch.log.1 when it would pass the cap, and logs prints the older file first', () => {
    dir = mkdtempSync(join(tmpdir(), 'corch-log-'))
    expect(readLogs(dir)).toBeNull()
    const log = new CappedLog(logPath(dir), 10)
    log.write('one\n')
    log.write('two\n')
    expect(readLogs(dir)).toBe('one\ntwo\n')

    log.write('three\n')
    log.write('four\n')
    log.write('five\n')
    expect(readLogs(dir)).toBe('three\nfour\nfive\n')
    for (const file of [logPath(dir), previousLogPath(dir)]) expect(statSync(file).size).toBeLessThanOrEqual(10)

    log.write('a line longer than the cap\n')
    expect(readLogs(dir)).toBe('four\nfive\na line lon')
  })

  test('never writes through a symlink at the log path, and drops the line without throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'corch-log-'))
    const outside = join(dir, 'outside')
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, logPath(dir))
    expect(() => new CappedLog(logPath(dir)).write('a line\n')).not.toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
  })
})

describe('logsCommand', () => {
  test('shows control characters as ? but keeps line breaks and tabs', () => {
    dir = mkdtempSync(join(tmpdir(), 'corch-log-'))
    writeFileSync(logPath(dir), 'a\t\x1b[31mred\x1b[0m\r\nbell\x07\x00 \x7f\u009b\n')
    let printed = ''
    expect(logsCommand(dir, true, (text) => (printed += text))).toBe(0)
    expect(printed).toBe('a\t?[31mred?[0m?\nbell?? ??\n')
  })
})
