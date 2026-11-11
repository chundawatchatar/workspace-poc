import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { type Principal, schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import type { ServerFrame } from '@orch/shared'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { SessionEnded } from './session-ended.service'

let domain: TestDomain
/** Every `skipAuthorization` line; the service must log none. */
const skipped: string[] = []

beforeAll(async () => {
  domain = await createTestDomain({ log: (line) => skipped.push(line) })
  await domain
    .forAuthLibrary()
    .insert(schema.user)
    .values([
      { id: 'user-a', name: 'Ada', email: 'ada@example.com' },
      { id: 'user-b', name: 'Bob', email: 'bob@example.com' },
    ])
  const now = new Date()
  const link = (userId: string, machineId: string) =>
    domain.forUser({ userId }).machines.insert({ machineId, name: machineId, lastOpenedAt: now, createdAt: now })
  await link('user-a', 'm1')
  await link('user-a', 'm2')
  await link('user-b', 'm3')
})

afterEach(() => mock.restore())

afterAll(async () => {
  await domain.close()
})

/** A registered fake tunnel that records the frames sent to it. */
function online(registry: MachineRegistry, machineId: string) {
  const frames: ServerFrame[] = []
  registry.register({ machineId, send: (frame) => frames.push(frame), close: () => {} })
  return frames
}

describe('SessionEnded', () => {
  test("sends session.ended only to the user's own online machines", async () => {
    const registry = new MachineRegistry()
    const m1 = online(registry, 'm1')
    const m3 = online(registry, 'm3')
    const service = new SessionEnded({ forUser: (p: Principal) => domain.forUser(p), registry })

    await service.ended('user-a')
    expect(m1).toEqual([{ type: 'session.ended', accountId: 'user-a' }])
    // m2 has no tunnel, so there is nothing to send to.
    expect(registry.get('m2')).toBeUndefined()
    expect(m3).toEqual([])
    expect(skipped).toEqual([])
  })

  test('a failing lookup is logged as one fixed line without the user id, and never rejects', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const service = new SessionEnded({
      forUser: () => {
        throw new Error('database down for user-a')
      },
      registry: new MachineRegistry(),
    })
    await service.ended('user-a')
    expect(errors.mock.calls).toEqual([['could not tell machines that a session ended']])
  })
})
