import { describe, expect, test } from 'bun:test'
import type { ServerFrame } from '@orch/shared'
import { type MachineConnection, MachineRegistry } from '../tunnel/tunnel.service'
import { forwardedPath, HttpForwarder } from './forward.service'

const encoder = new TextEncoder()

/** A forwarder with fake machines `m1` and `m2` whose sent frames are recorded. */
function setup(requestTimeoutMs = 1000) {
  const registry = new MachineRegistry()
  const sent: Record<string, ServerFrame[]> = { m1: [], m2: [] }
  const conns: Record<string, MachineConnection> = {}
  for (const machineId of ['m1', 'm2']) {
    conns[machineId] = { machineId, send: (frame) => sent[machineId]?.push(frame), close: () => {} }
    registry.register(conns[machineId])
  }
  const forwarder = new HttpForwarder({ registry, requestTimeoutMs })
  const m1 = conns.m1 as MachineConnection
  const m2 = conns.m2 as MachineConnection
  return { forwarder, sent, m1, m2 }
}

function get(path: string) {
  return new Request(`http://server/m/m1${path}`)
}

describe('forwardedPath', () => {
  test('keeps the path after the machine segment and its query exactly as the URL has them', () => {
    expect(forwardedPath('http://s/m/abc/api/git/status?cwd=%2Ftmp')).toBe('/api/git/status?cwd=%2Ftmp')
    expect(forwardedPath('http://s/m/a%2Fb/api/x%20y')).toBe('/api/x%20y')
    expect(forwardedPath('http://s/m/abc/api')).toBeNull()
    expect(forwardedPath('http://s/m/abc/ws/x')).toBeNull()
  })
})

describe('HttpForwarder', () => {
  test('matches frames by connection and id, so interleaved and foreign frames reach only their own request', async () => {
    const { forwarder, sent, m1, m2 } = setup()
    const first = forwarder.forward('m1', get('/api/a'))
    const second = forwarder.forward('m1', get('/api/b'))
    await Bun.sleep(0)
    expect(sent.m1?.map((f) => f.type === 'http.request' && [f.id, f.path])).toEqual([
      [1, '/api/a'],
      [2, '/api/b'],
    ])

    // Another machine's tunnel uses the same ids, and must not settle m1's requests.
    forwarder.handleFrame(m2, { type: 'http.response', id: 1, status: 500, headers: [] })
    forwarder.handleFrame(m1, { type: 'http.response', id: 2, status: 201, headers: [['x-n', '2']] })
    forwarder.handleFrame(m1, { type: 'http.response', id: 1, status: 200, headers: [['x-n', '1']] })
    forwarder.handleFrame(m1, { type: 'http.response', id: 1, status: 404, headers: [] })
    forwarder.handleFrame(m1, { type: 'http.body', id: 1, data: encoder.encode('one-') })
    forwarder.handleFrame(m1, { type: 'http.body', id: 2, data: encoder.encode('two') })
    forwarder.handleFrame(m1, { type: 'http.body', id: 1, data: encoder.encode('one') })
    forwarder.handleFrame(m1, { type: 'http.end', id: 2 })
    forwarder.handleFrame(m1, { type: 'http.end', id: 1 })
    forwarder.handleFrame(m1, { type: 'http.body', id: 1, data: encoder.encode('late') })
    forwarder.handleFrame(m1, { type: 'http.end', id: 99 })

    const [a, b] = await Promise.all([first, second])
    expect([a.status, a.headers.get('x-n'), await a.text()]).toEqual([200, '1', 'one-one'])
    expect([b.status, b.headers.get('x-n'), await b.text()]).toEqual([201, '2', 'two'])
    expect(forwarder.size).toBe(0)
  })

  test('gives 504 when the head is late, ignores frames after that, and never cuts off a body once the head arrived', async () => {
    const { forwarder, m1 } = setup(40)
    const late = await forwarder.forward('m1', get('/api/slow'))
    expect(late.status).toBe(504)
    expect(await late.text()).toBe('Gateway Timeout')
    expect(forwarder.size).toBe(0)
    forwarder.handleFrame(m1, { type: 'http.response', id: 1, status: 200, headers: [] })
    forwarder.handleFrame(m1, { type: 'http.end', id: 1 })

    const pending = forwarder.forward('m1', get('/api/steady'))
    await Bun.sleep(0)
    forwarder.handleFrame(m1, { type: 'http.response', id: 2, status: 200, headers: [] })
    const response = await pending
    for (const chunk of ['a', 'b', 'c']) {
      await Bun.sleep(25)
      forwarder.handleFrame(m1, { type: 'http.body', id: 2, data: encoder.encode(chunk) })
    }
    forwarder.handleFrame(m1, { type: 'http.end', id: 2 })
    expect(await response.text()).toBe('abc')
  })

  test('a failed end or a closed tunnel errors a streaming body, and a closed tunnel gives 502 before the head', async () => {
    const { forwarder, m1 } = setup()
    const failed = forwarder.forward('m1', get('/api/a'))
    const streaming = forwarder.forward('m1', get('/api/b'))
    const waiting = forwarder.forward('m1', get('/api/c'))
    await Bun.sleep(0)
    for (const id of [1, 2]) forwarder.handleFrame(m1, { type: 'http.response', id, status: 200, headers: [] })
    forwarder.handleFrame(m1, { type: 'http.body', id: 1, data: encoder.encode('partial') })
    forwarder.handleFrame(m1, { type: 'http.end', id: 1, error: 'host crashed' })
    await expect((await failed).text()).rejects.toThrow()

    const body = (await streaming).text()
    forwarder.connectionClosed(m1)
    await expect(body).rejects.toThrow()
    const offline = await waiting
    expect([offline.status, await offline.text()]).toEqual([502, 'Bad Gateway'])
    expect(forwarder.size).toBe(0)
    expect((await forwarder.forward('m1', get('/api/d'))).status).toBe(502)
  })

  test('drops the entry when the browser aborts, without sending anything more', async () => {
    const { forwarder, sent } = setup()
    const abort = new AbortController()
    const pending = forwarder.forward('m1', new Request('http://server/m/m1/api/x', { signal: abort.signal }))
    await Bun.sleep(0)
    expect(forwarder.size).toBe(1)
    abort.abort()
    expect((await pending).status).toBe(502)
    expect(forwarder.size).toBe(0)
    expect(sent.m1).toHaveLength(1)
  })
})
