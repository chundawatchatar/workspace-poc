import { describe, expect, test } from 'bun:test'
import { clientUrlFromServerUrl, parseClientUrl } from './addresses.service'

describe('client URLs', () => {
  test('the client URL is an http(s) CLIENT_URL, or SERVER_URL with ws(s) swapped for http(s)', () => {
    expect(parseClientUrl('https://orch.example/app/')).toBe('https://orch.example/app')
    expect(parseClientUrl('http://127.0.0.1:3220')).toBe('http://127.0.0.1:3220')
    for (const bad of ['ftp://orch.example', 'javascript:alert(1)', 'orch.example', 'https://u:p@orch.example']) {
      expect(parseClientUrl(bad)).toBeNull()
    }
    expect(clientUrlFromServerUrl('wss://relay.example.com:8443/base/')).toBe('https://relay.example.com:8443/base')
    expect(clientUrlFromServerUrl('ws://127.0.0.1:4600')).toBe('http://127.0.0.1:4600')
    expect(clientUrlFromServerUrl('https://relay.example.com')).toBeNull()
  })
})
