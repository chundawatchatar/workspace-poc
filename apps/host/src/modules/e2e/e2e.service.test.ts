import { describe, expect, test } from 'bun:test'
import { E2eError, RELAY_TICKET_TTL_SECONDS, startBrowserHandshake } from '@orch/shared'
import type { Principal } from '../../lib/principal'
import { testDevice } from '../remote-access/device-proof.testing'
import { createTestMachineKey } from '../tunnel/tunnel.testing'
import { E2eDeviceMismatch, E2eSessionClosed, E2eSessions, MAX_SESSIONS_PER_DEVICE } from './e2e.service'

const machineKey = createTestMachineKey()
const START = Date.UTC(2026, 10, 12, 12, 0)

/** Sessions on a fake clock, which `advance` moves forward. */
function setup() {
  let now = START
  const sessions = new E2eSessions({ machineKey: () => machineKey, now: () => now })
  return {
    sessions,
    advance: (ms: number) => {
      now += ms
    },
  }
}

type TestDevice = Awaited<ReturnType<typeof testDevice>>

/** A browser hello from `device`, and the step that checks the machine's answer. */
const hello = (device: TestDevice) => startBrowserHandshake({ machineId: machineKey.machineId, device: device.signer })

const asKey = (device: TestDevice): Principal => ({ kind: 'key', keyId: 'k1', name: 'laptop', deviceId: device.id })
const asAccount = (device: TestDevice, ticketExp: number): Principal => ({
  kind: 'account',
  accountId: 'acct-1',
  deviceId: device.id,
  ticketExp,
})

describe('E2eSessions', () => {
  test("a session the browser verifies seals with the host's copy, and expires with its ticket or a ticket's lifetime", async () => {
    const { sessions, advance } = setup()
    const device = await testDevice()

    const browser = await hello(device)
    const opened = await sessions.open(asKey(device), browser.hello)
    expect(opened.expiresAt).toBe(new Date(START + RELAY_TICKET_TTL_SECONDS * 1000).toISOString())
    const session = await browser.finish(opened.hello, machineKey.publicKey)
    const kept = sessions.get(opened.sessionId)
    const sealed = await session.seal(new TextEncoder().encode('ls'))
    expect(new TextDecoder().decode(await kept?.session.open(sealed))).toBe('ls')

    const ticketExp = Math.floor(START / 1000) + 20
    const account = await sessions.open(asAccount(device, ticketExp), (await hello(device)).hello)
    expect(account.expiresAt).toBe(new Date(ticketExp * 1000).toISOString())

    advance(20_000)
    expect(sessions.get(account.sessionId)).toBeNull()
    expect(sessions.get(opened.sessionId)).not.toBeNull()
    advance(RELAY_TICKET_TTL_SECONDS * 1000)
    expect(sessions.get(opened.sessionId)).toBeNull()
    // Expired sessions are dropped from memory, not only hidden.
    expect((sessions as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  test('a device holds at most 8 live sessions, a ninth drops its oldest, and other devices keep theirs', async () => {
    const { sessions } = setup()
    const [device, other] = await Promise.all([testDevice(), testDevice()])
    const others = await sessions.open(asKey(other), (await hello(other)).hello)
    const ids: string[] = []
    for (let i = 0; i <= MAX_SESSIONS_PER_DEVICE; i++) {
      ids.push((await sessions.open(asKey(device), (await hello(device)).hello)).sessionId)
    }
    expect(ids.map((id) => sessions.get(id) !== null)).toEqual([false, ...Array(MAX_SESSIONS_PER_DEVICE).fill(true)])
    expect(sessions.get(others.sessionId)).not.toBeNull()
  })

  test('closeWhere closes only the sessions it matches, also one still opening, and closeAll closes the rest', async () => {
    const { sessions } = setup()
    const [first, second] = await Promise.all([testDevice(), testDevice()])
    const a = await sessions.open(asKey(first), (await hello(first)).hello)
    const b = await sessions.open(asKey(second), (await hello(second)).hello)

    const opening = sessions.open(asKey(first), (await hello(first)).hello)
    sessions.closeWhere((principal) => principal.deviceId === first.id)
    await expect(opening).rejects.toBeInstanceOf(E2eSessionClosed)
    expect(sessions.get(a.sessionId)).toBeNull()
    expect(sessions.get(b.sessionId)).not.toBeNull()

    sessions.closeAll()
    expect(sessions.get(b.sessionId)).toBeNull()
  })

  test("a hello another device signed, or one whose signature doesn't verify, opens nothing", async () => {
    const { sessions } = setup()
    const [device, other] = await Promise.all([testDevice(), testDevice()])
    const { hello: theirs } = await hello(other)
    await expect(sessions.open(asKey(device), theirs)).rejects.toBeInstanceOf(E2eDeviceMismatch)
    const { hello: mine } = await hello(device)
    const forged = { ...mine, signature: mine.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }
    await expect(sessions.open(asKey(device), forged)).rejects.toBeInstanceOf(E2eError)
  })
})
