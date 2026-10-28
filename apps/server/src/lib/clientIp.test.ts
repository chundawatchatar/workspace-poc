import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { clientIpReader } from './clientIp'

/** An app that answers with the client IP it reads, served with a fake Bun server whose socket address is `socket`. */
function setup(trustProxy: boolean, socket = '10.0.0.9') {
  const read = clientIpReader({ trustProxy })
  const app = new Hono().get('/', (c) => c.text(read(c)))
  const server = { requestIP: () => ({ address: socket, family: 'IPv4', port: 1234 }) }
  return async (headers: Record<string, string> = {}) => (await app.request('/', { headers }, server)).text()
}

describe('clientIpReader', () => {
  test('uses the socket address and ignores X-Forwarded-For unless the proxy is trusted', async () => {
    const direct = setup(false)
    expect(await direct()).toBe('10.0.0.9')
    expect(await direct({ 'x-forwarded-for': '1.1.1.1' })).toBe('10.0.0.9')
  })

  test('behind a trusted proxy it takes the rightmost X-Forwarded-For entry, else the socket address', async () => {
    const proxied = setup(true)
    expect(await proxied({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4 , 5.6.7.8' })).toBe('5.6.7.8')
    expect(await proxied({ 'x-forwarded-for': ' , ' })).toBe('10.0.0.9')
    expect(await proxied()).toBe('10.0.0.9')
  })
})
