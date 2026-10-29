import { afterEach, describe, expect, test } from 'bun:test'
import { createDomain } from '@orch/domain'
import { createTestDb, type TestDb } from '@orch/domain/testing'
import { checkDatabase, databaseLocation } from './database'

const open: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()))
})

/** A local port nothing listens on. */
function closedPort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = listener
  listener.stop(true)
  return port
}

describe('checkDatabase', () => {
  test('passes a reachable, migrated database', async () => {
    const db: TestDb = await createTestDb()
    open.push(db)
    expect(await checkDatabase(db, 'test')).toBeNull()
  })

  test('says an unreachable database is unreachable, with its host and port but not the password', async () => {
    const url = `postgres://orch:s3cret-pw@127.0.0.1:${closedPort()}/orch`
    const domain = createDomain(url, { log: () => {} })
    open.push(domain)
    const location = databaseLocation(url)
    const message = await checkDatabase(domain.skipAuthorization('test'), location)
    expect(message).toContain('unreachable')
    expect(message).toContain(location)
    expect(message).not.toContain('s3cret-pw')
  })
})
