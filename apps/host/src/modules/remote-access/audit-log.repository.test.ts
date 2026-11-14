import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AuditLine, auditLine } from '@orch/shared'
import { AUDIT_LOG_KEEP_LINES, AUDIT_LOG_MAX_LINES, AuditLogRepository, auditLogPath } from './audit-log.repository'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-audit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const closed = (n: number): AuditLine => ({ kind: 'closed', session: `s${n}`, at: new Date(n * 1000).toISOString() })
const fileLines = (file: string) => readFileSync(file, 'utf8').trimEnd().split('\n')

describe('AuditLogRepository', () => {
  test('an append past the cap rewrites the file with the newest lines plus the new one', () => {
    const file = auditLogPath(dir)
    const repository = new AuditLogRepository(file)
    for (let n = 1; n <= AUDIT_LOG_MAX_LINES; n++) repository.append(closed(n))
    expect(fileLines(file)).toHaveLength(AUDIT_LOG_MAX_LINES)

    repository.append(closed(AUDIT_LOG_MAX_LINES + 1))
    const lines = fileLines(file)
    expect(lines).toHaveLength(AUDIT_LOG_KEEP_LINES + 1)
    expect(JSON.parse(lines.at(-1) ?? '')).toEqual(closed(AUDIT_LOG_MAX_LINES + 1))
    expect(JSON.parse(lines[0] ?? '')).toEqual(closed(AUDIT_LOG_MAX_LINES - AUDIT_LOG_KEEP_LINES + 1))
    // The rewrite went through a temp file, which is gone.
    expect(readdirSync(dir)).toEqual(['remote-audit.jsonl'])

    // A new repository on the cut file counts its lines again, so the next append just appends.
    new AuditLogRepository(file).append(closed(AUDIT_LOG_MAX_LINES + 2))
    expect(fileLines(file)).toHaveLength(AUDIT_LOG_KEEP_LINES + 2)
    for (const line of fileLines(file)) expect(auditLine.safeParse(JSON.parse(line)).success).toBe(true)
  })

  test('reads every valid line in order, skipping lines that are not JSON or not an entry', () => {
    const file = join(dir, 'audit.jsonl')
    const repository = new AuditLogRepository(file)
    expect(repository.read()).toEqual([])
    repository.append(closed(1))
    appendFileSync(
      file,
      '{ broken\n{"kind":"closed","session":"s9","at":"yesterday"}\n{"kind":"closed","session":"s9","at":"2026-11-11T00:00:00.000Z","key":"k"}\n\n',
    )
    repository.append(closed(2))
    expect(repository.read()).toEqual([closed(1), closed(2)])
  })
})
