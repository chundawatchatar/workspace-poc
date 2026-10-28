import { describe, expect, test } from 'bun:test'
import { connectionCopy } from './connection'
import type { ConnectionStatus } from './store'

const statuses: ConnectionStatus[] = ['connecting', 'open', 'reconnecting', 'offline', 'denied']

describe('connection copy', () => {
  test('each status has its own sidebar label and dot, and only a lost connection shows a banner', () => {
    const footer = statuses.map((status) => [connectionCopy(status).label, connectionCopy(status).dot])
    expect(footer).toEqual([
      ['Connecting…', 'bg-warn'],
      ['Host connected', 'bg-good'],
      ['Reconnecting…', 'bg-warn'],
      ['Machine offline', 'bg-bad'],
      ['Access denied', 'bg-bad'],
    ])
    expect(new Set(footer.map(([label]) => label)).size).toBe(statuses.length)
    expect(connectionCopy('open').banner).toBeNull()
    expect(statuses.filter((status) => connectionCopy(status).retry)).toEqual(['denied'])
  })

  test('the local host being down keeps the old wording and the offline hint', () => {
    expect(connectionCopy('reconnecting')).toMatchObject({ message: 'The host is not running.', hint: 'offline' })
  })
})
