import { describe, expect, test } from 'bun:test'
import { localHost } from './localHost'

const port = 4599

describe('localHost', () => {
  test('accepts each loopback name with the listening port, the name in any case', () => {
    for (const host of ['127.0.0.1:4599', 'localhost:4599', 'LOCALHOST:4599', 'LocalHost:4599', '[::1]:4599']) {
      expect({ host, local: localHost(host, port) }).toEqual({ host, local: true })
    }
  })

  test('refuses a missing header, another port or name, and anything that only looks local', () => {
    const refused = [
      null,
      undefined,
      '',
      '127.0.0.1',
      'localhost',
      '127.0.0.1:4600',
      '127.0.0.1:04599',
      'localhost:',
      'evil.example:4599',
      'localhost.:4599',
      '::1:4599',
      '::1',
      '[::1]',
      '127.0.0.2:4599',
      'user@localhost:4599',
      'localhost:4599/x',
      'localhost:4599 ',
      'localhost.evil.example:4599',
    ]
    for (const host of refused) expect({ host, local: localHost(host, port) }).toEqual({ host, local: false })
  })
})
