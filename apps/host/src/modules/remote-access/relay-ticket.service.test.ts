import { describe, expect, test } from 'bun:test'
import { SpentTickets, verifyRelayTicket } from './relay-ticket.service'
import { testRelayKey } from './relay-ticket.testing'

const signer = testRelayKey('k1')
const other = testRelayKey('k1')
const mine = { sub: 'acct-1', aud: 'machine-1' }
const check = { keys: [signer.relayKey], machineId: 'machine-1', accountId: 'acct-1', now: Date.now() }
const seconds = Math.floor(check.now / 1000)

describe('verifyRelayTicket', () => {
  test('accepts a ticket signed for this machine and the linked account, and refuses every other', () => {
    expect(verifyRelayTicket(signer.ticket(mine), check)).toMatchObject({ ...mine, jti: expect.any(String) })

    const [header, payload] = signer.ticket(mine).split('.')
    const refused = {
      'signed by another key with the same kid': other.ticket(mine),
      'a payload swapped under the signature': `${header}.${payload}.${signer.ticket({ ...mine, sub: 'x' }).split('.')[2]}`,
      'another machine': signer.ticket({ ...mine, aud: 'machine-2' }),
      'another account': signer.ticket({ ...mine, sub: 'acct-2' }),
      'expired beyond the skew': signer.ticket({ ...mine, exp: seconds - 31 }),
      'living longer than a fresh one could': signer.ticket({ ...mine, exp: seconds + 3600 }),
      'an unknown kid': signer.ticket(mine, 'k2'),
      'not a ticket': 'not.a.ticket',
    }
    for (const [why, ticket] of Object.entries(refused)) {
      expect({ why, payload: verifyRelayTicket(ticket, check) }).toEqual({ why, payload: null })
    }
    // A small clock skew is allowed.
    expect(verifyRelayTicket(signer.ticket({ ...mine, exp: seconds - 10 }), check)).not.toBeNull()
  })
})

describe('SpentTickets', () => {
  test('a ticket id is spent once until it expires', () => {
    const spent = new SpentTickets()
    const payload = { ...mine, exp: seconds + 60, jti: 'a'.repeat(22) }
    expect(spent.spend(payload, check.now)).toBe(true)
    expect(spent.spend(payload, check.now)).toBe(false)
    expect(spent.spend({ ...payload, jti: 'b'.repeat(22) }, check.now)).toBe(true)
    // Long after it expired, it is forgotten, and verifying would refuse it anyway.
    expect(spent.spend(payload, check.now + 3_600_000)).toBe(true)
  })
})
