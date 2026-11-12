import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLogRepository } from './audit-log.repository'
import { AUDIT_LOG_ENTRIES, AuditLogService } from './audit-log.service'
import { fingerprintOf } from './device-proof.service'

const deviceId = 'd'.repeat(43)
const MINUTE = 60_000
const iso = (minutes: number) => new Date(minutes * MINUTE).toISOString()

let dir: string
let clock: number
let service: AuditLogService
let errors: ReturnType<typeof spyOn>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-audit-'))
  clock = 0
  service = new AuditLogService(new AuditLogRepository(join(dir, 'audit.jsonl')), () => clock)
  errors = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errors.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

describe('AuditLogService', () => {
  test('merges each opened socket with its close, newest first, keeping only ids and fingerprints', () => {
    service.record({
      kind: 'opened',
      session: 'a',
      principal: { kind: 'account', accountId: 'acct-1', deviceId, ticketExp: 0 },
    })
    clock = MINUTE
    service.record({ kind: 'opened', session: 'k', principal: { kind: 'key', keyId: 'k1', name: 'laptop', deviceId } })
    clock = 2 * MINUTE
    service.record({ kind: 'closed', session: 'a' })
    service.record({ kind: 'refused', reason: 'proof_refused' })
    service.record({ kind: 'closed', session: 'gone' })

    const fingerprint = fingerprintOf(deviceId)
    expect(service.recent()).toEqual([
      { kind: 'refused', reason: 'proof_refused', at: iso(2) },
      { kind: 'session', session: 'k', principal: 'key', keyId: 'k1', fingerprint, openedAt: iso(1), closedAt: null },
      {
        kind: 'session',
        session: 'a',
        principal: 'account',
        accountId: 'acct-1',
        fingerprint,
        openedAt: iso(0),
        closedAt: iso(2),
      },
    ])
  })

  test('answers at most the newest 50 entries', () => {
    for (let n = 0; n < AUDIT_LOG_ENTRIES + 5; n++) {
      clock = n * MINUTE
      service.record({ kind: 'refused', reason: 'no_auth' })
    }
    const recent = service.recent()
    expect(recent).toHaveLength(AUDIT_LOG_ENTRIES)
    expect(recent[0]).toMatchObject({ at: iso(AUDIT_LOG_ENTRIES + 4) })
  })

  test('a write that fails is reported once, without the event, and never throws', () => {
    // A folder where the file should be makes every append fail.
    const file = join(dir, 'blocked.jsonl')
    mkdirSync(file)
    const blocked = new AuditLogService(new AuditLogRepository(file))
    blocked.record({
      kind: 'opened',
      session: 'secret-session',
      principal: { kind: 'account', accountId: 'acct-1', deviceId, ticketExp: 0 },
    })
    blocked.record({ kind: 'refused', reason: 'key_refused' })
    expect(errors).toHaveBeenCalledTimes(1)
    const message = String(errors.mock.calls[0]?.[0])
    expect(message).toContain(file)
    for (const value of ['secret-session', 'acct-1', deviceId, fingerprintOf(deviceId)]) {
      expect(message).not.toContain(value)
    }
  })
})
