import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createTestDomain, type TestDomain } from '../testing'
import { machines } from './machines'
import { user } from './user'

const open: TestDomain[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((domain) => domain.close()))
})

const MACHINE = 'a'.repeat(43)

describe('machines table', () => {
  test('allows one row per user and machine id, and goes with its user', async () => {
    const domain = await createTestDomain({ log: () => {} })
    open.push(domain)
    const db = domain.forAuthLibrary()
    await db.insert(user).values([
      { id: 'a', name: 'Ada', email: 'ada@example.com' },
      { id: 'b', name: 'Bob', email: 'bob@example.com' },
    ])
    const a = domain.forUser({ userId: 'a' }).machines
    const b = domain.forUser({ userId: 'b' }).machines
    const row = await a.insert({ machineId: MACHINE, name: 'Laptop', lastOpenedAt: new Date() })
    expect(row).toMatchObject({ userId: 'a', machineId: MACHINE, name: 'Laptop' })
    expect(row.id).toBeString()
    expect(row.createdAt).toBeInstanceOf(Date)

    await expect(a.insert({ machineId: MACHINE, name: 'Again', lastOpenedAt: new Date() })).rejects.toThrow()
    await b.insert({ machineId: MACHINE, name: 'Shared', lastOpenedAt: new Date() })

    await db.delete(user).where(eq(user.id, 'a'))
    expect(await db.select({ userId: machines.userId }).from(machines)).toEqual([{ userId: 'b' }])
  })
})
