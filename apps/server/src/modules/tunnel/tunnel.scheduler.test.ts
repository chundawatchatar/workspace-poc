import { describe, expect, test } from 'bun:test'
import { decodeFrame, serverFrame } from '@orch/shared'
import { FrameScheduler } from './tunnel.scheduler'

/** A scheduler over a fake socket whose buffered amount the test sets. */
function setup() {
  const socket = { buffered: 0, written: [] as (string | Uint8Array<ArrayBuffer>)[] }
  const scheduler = new FrameScheduler({
    write: (data) => socket.written.push(data),
    bufferedAmount: () => socket.buffered,
    highWaterMark: 1000,
  })
  const sent = () => socket.written.map((data) => decodeFrame(serverFrame, data))
  return { socket, scheduler, sent }
}

describe('FrameScheduler', () => {
  test('writes at once while the buffer has room', () => {
    const { scheduler, sent } = setup()
    scheduler.send({ type: 'ws.data', channel: 1, data: 'a' })
    expect(sent()).toEqual([{ type: 'ws.data', channel: 1, data: 'a' }])
    expect(scheduler.queued).toBe(0)
  })

  test('sends queued ws frames ahead of a large http.request once a full buffer drains, each lane in order', () => {
    const { socket, scheduler } = setup()
    socket.buffered = 5000
    const body = new Uint8Array(1024 * 1024).fill(7)
    scheduler.send({ type: 'http.request', id: 1, method: 'POST', path: '/api/fs/upload', headers: [], body })
    scheduler.send({ type: 'http.request', id: 2, method: 'GET', path: '/api/a', headers: [] })
    for (const data of ['one', 'two', 'three']) scheduler.send({ type: 'ws.data', channel: 1, data })
    expect(socket.written).toHaveLength(0)

    socket.buffered = 0
    scheduler.flush()
    // A 1 MiB body makes a frame too large for `decodeFrame`, so that write is recognised by its size.
    const labels = socket.written.map((data) => {
      if (typeof data !== 'string' && data.byteLength > body.byteLength) return 'upload'
      const frame = decodeFrame(serverFrame, data)
      return frame?.type === 'ws.data' ? frame.data : frame?.type
    })
    expect(labels).toEqual(['one', 'two', 'three', 'upload', 'http.request'])
  })

  test('stops writing when the buffer fills and clears its queue on close', () => {
    const { socket, scheduler } = setup()
    socket.buffered = 5000
    scheduler.send({ type: 'ws.data', channel: 1, data: 'a' })
    scheduler.send({ type: 'ws.data', channel: 1, data: 'b' })
    scheduler.clear()
    socket.buffered = 0
    scheduler.flush()
    expect(socket.written).toHaveLength(0)
  })
})
