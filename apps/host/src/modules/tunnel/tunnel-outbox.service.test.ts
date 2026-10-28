import { describe, expect, test } from 'bun:test'
import { decodeFrame, type MachineFrame, machineFrame } from '@orch/shared'
import { TunnelChannels } from './tunnel-channels.service'
import { MAX_BODY_CHUNK_BYTES, TunnelHttp } from './tunnel-http.service'
import { BULK_CAP_BYTES, TunnelOutbox } from './tunnel-outbox.service'

/** An outbox over a fake socket whose buffered amount the test sets, wired to HTTP and channels as the client does. */
function setup() {
  const socket = { buffered: Number.POSITIVE_INFINITY, written: [] as MachineFrame[] }
  const outbox = new TunnelOutbox({
    write: (data) => {
      const frame = decodeFrame(machineFrame, data)
      if (frame) socket.written.push(frame)
    },
    bufferedAmount: () => socket.buffered,
  })
  let mostQueued = 0
  const send = (frame: MachineFrame) => {
    outbox.send(frame)
    mostQueued = Math.max(mostQueued, outbox.bulkBytes)
  }
  const http = new TunnelHttp(
    async () => new Response(new Uint8Array(4 * 1024 * 1024).fill(1)),
    send,
    () => outbox.room(),
  )
  const channels = new TunnelChannels((_path, _headers, conn) => {
    for (const line of ['$ ls', 'a b c']) conn.send(line)
    return { message: () => {}, close: () => {} }
  }, send)
  return { socket, outbox, http, channels, mostQueued: () => mostQueued }
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

describe('TunnelOutbox', () => {
  test('holds a large response to the bulk cap while the socket is full, and lets terminal output overtake it', async () => {
    const { socket, outbox, http, channels, mostQueued } = setup()
    http.request({ type: 'http.request', id: 1, method: 'GET', path: '/api/big', headers: [] })
    await until(() => outbox.bulkBytes >= BULK_CAP_BYTES)
    await Bun.sleep(30)
    channels.receive({ type: 'ws.open', channel: 1, path: '/ws/term/t', headers: [] })
    expect(socket.written).toEqual([])
    expect(outbox.bulkBytes).toBeLessThan(BULK_CAP_BYTES + 2 * MAX_BODY_CHUNK_BYTES)

    socket.buffered = 0
    await until(() => socket.written.some((f) => f.type === 'http.end'))
    const types = socket.written.map((f) => f.type)
    expect(types.slice(0, 3)).toEqual(['ws.data', 'ws.data', 'http.response'])
    const body = socket.written.reduce((sum, f) => sum + (f.type === 'http.body' ? f.data.byteLength : 0), 0)
    expect(body).toBe(4 * 1024 * 1024)
    expect(mostQueued()).toBeLessThan(BULK_CAP_BYTES + 2 * MAX_BODY_CHUNK_BYTES)
  })

  test('after close it writes nothing, even once the socket drains, and lets waiting readers go', async () => {
    const { socket, outbox } = setup()
    for (let i = 0; i < 20; i++) outbox.send({ type: 'http.body', id: 1, data: new Uint8Array(MAX_BODY_CHUNK_BYTES) })
    let released = false
    void outbox.room().then(() => {
      released = true
    })
    outbox.close()
    outbox.send({ type: 'ping', nonce: 1 })
    socket.buffered = 0
    await Bun.sleep(30)
    expect(released).toBe(true)
    expect(socket.written).toEqual([])
  })
})
