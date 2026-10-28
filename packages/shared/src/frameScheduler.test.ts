import { describe, expect, test } from 'bun:test'
import { decodeFrame, type MachineFrame, machineFrame, type ServerFrame, serverFrame } from './contracts/tunnel'
import { FrameScheduler } from './frameScheduler'

/** A scheduler over a fake socket whose buffered amount the test sets, with the server's lanes. */
function setup() {
  const socket = { buffered: 0, written: [] as (string | Uint8Array<ArrayBuffer>)[] }
  const scheduler = new FrameScheduler<ServerFrame>({
    write: (data) => socket.written.push(data),
    bufferedAmount: () => socket.buffered,
    lane: (frame) => (frame.type === 'http.request' ? 'bulk' : 'interactive'),
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

  test('with the host lanes, queued ws.data frames overtake queued http.body frames, and bulk bytes are counted', () => {
    const written: (string | Uint8Array<ArrayBuffer>)[] = []
    let buffered = 5000
    const scheduler = new FrameScheduler<MachineFrame>({
      write: (data) => written.push(data),
      bufferedAmount: () => buffered,
      lane: (frame) => (frame.type.startsWith('http.') ? 'bulk' : 'interactive'),
      highWaterMark: 1000,
    })
    for (const n of [1, 2, 3]) scheduler.send({ type: 'http.body', id: 1, data: new Uint8Array(100).fill(n) })
    for (const data of ['a', 'b']) scheduler.send({ type: 'ws.data', channel: 1, data })
    expect(scheduler.bulkBytes).toBeGreaterThan(300)

    buffered = 0
    scheduler.flush()
    const labels = written.map((data) => {
      const frame = decodeFrame(machineFrame, data)
      if (frame?.type === 'ws.data') return frame.data
      return frame?.type === 'http.body' ? frame.data[0] : frame?.type
    })
    expect(labels).toEqual(['a', 'b', 1, 2, 3])
    expect(scheduler.bulkBytes).toBe(0)
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
