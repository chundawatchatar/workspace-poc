import { describe, expect, test } from 'bun:test'
import { relayedRequestHeaders, relayedSocketHeaders } from './relay'

describe('relayed headers', () => {
  test('drop the account cookies in any case and keep the other headers in order', () => {
    for (const cookie of ['cookie', 'Cookie', 'COOKIE']) {
      const headers = new Headers([
        ['x-orch-access-key', 'k'],
        [cookie, 'session=abc'],
        ['x-thing', 'a'],
        ['connection', 'keep-alive'],
      ])
      expect(relayedRequestHeaders(headers)).toEqual([
        ['x-orch-access-key', 'k'],
        ['x-thing', 'a'],
      ])
      headers.set('sec-websocket-protocol', 'orch')
      expect(relayedSocketHeaders(headers)).toEqual([
        ['sec-websocket-protocol', 'orch'],
        ['x-orch-access-key', 'k'],
        ['x-thing', 'a'],
      ])
    }
  })
})
