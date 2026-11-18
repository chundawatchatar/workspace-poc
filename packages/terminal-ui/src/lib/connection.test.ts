import { describe, expect, test } from 'bun:test'
import { DEFAULT_DENIED_HINT, DEFAULT_UNAPPROVED_HINT } from '../components/HostStatus'
import { connectionCopy } from './connection'
import type { ConnectionStatus } from './store'

const statuses: ConnectionStatus[] = ['connecting', 'open', 'reconnecting', 'offline', 'denied', 'unapproved']

describe('connection copy', () => {
  test('each status has its own sidebar label and dot, and only a lost connection shows a banner', () => {
    const footer = statuses.map((status) => [connectionCopy(status).label, connectionCopy(status).dot])
    expect(footer).toEqual([
      ['Connecting…', 'bg-warn'],
      ['Host connected', 'bg-good'],
      ['Reconnecting…', 'bg-warn'],
      ['Machine offline', 'bg-bad'],
      ['Access denied', 'bg-bad'],
      ['Waiting for approval', 'bg-warn'],
    ])
    expect(new Set(footer.map(([label]) => label)).size).toBe(statuses.length)
    expect(connectionCopy('open').banner).toBeNull()
    expect(statuses.filter((status) => connectionCopy(status).retry)).toEqual(['denied'])
  })

  test('a refused account is told nothing about keys, links or approval, and can try again', () => {
    const denied = connectionCopy('denied')
    expect(denied).toMatchObject({ label: 'Access denied', hint: 'denied', retry: true })
    for (const text of [denied.message, denied.banner, DEFAULT_DENIED_HINT])
      expect(text).not.toMatch(/key|link|approv/i)
    expect(DEFAULT_DENIED_HINT).toMatch(/connected to this account/)
    expect(DEFAULT_UNAPPROVED_HINT).toMatch(/approve/i)
  })

  test('the local host being down keeps the old wording and the offline hint', () => {
    expect(connectionCopy('reconnecting')).toMatchObject({ message: 'The host is not running.', hint: 'offline' })
  })
})
