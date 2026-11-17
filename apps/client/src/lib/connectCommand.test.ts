import { describe, expect, test } from 'bun:test'
import { connectCommand, shellWord } from './connectCommand'

describe('connectCommand', () => {
  test('names the email, the key and the server, quoting only what a shell would read otherwise', () => {
    const key = `oek_${'a'.repeat(21)}-_${'b'.repeat(20)}`
    expect(connectCommand({ email: 'ada.lovelace+box@example.com', key, serverUrl: 'wss://relay.example.com' })).toBe(
      `corch connect --email ada.lovelace+box@example.com --key ${key} --server wss://relay.example.com`,
    )
    expect(connectCommand({ email: "o'neil@example.com", key, serverUrl: 'ws://127.0.0.1:4600' })).toBe(
      `corch connect --email 'o'\\''neil@example.com' --key ${key} --server ws://127.0.0.1:4600`,
    )
    for (const special of [
      'a$b@x.co',
      'a b@x.co',
      'a*@x.co',
      'a!b@x.co',
      'a;b@x.co',
      '`a`@x.co',
      'a&b@x.co',
      '~a@x.co',
    ]) {
      expect(shellWord(special)).toBe(`'${special}'`)
    }
  })
})
