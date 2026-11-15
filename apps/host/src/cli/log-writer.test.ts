import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CappedLog, logPath, previousLogPath } from './log-writer'
import { readLogs } from './logs'

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
})
