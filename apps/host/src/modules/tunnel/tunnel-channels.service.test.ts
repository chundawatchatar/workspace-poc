import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { type MachineFrame, WS_CHANNEL_WINDOW_BYTES, wsPayloadBytes } from '@orch/shared'
import { CAUGHT_UP, deliver, type TermClient } from '@orch/terminal'
import type { SocketConn, SocketData } from '../../lib/socket'
import { CHANNEL_QUEUE_CAP_BYTES, type OpenSocket, TunnelChannels } from './tunnel-channels.service'

/** One handler run, as the test sees it. */
interface Opened {
  conn: SocketConn
  messages: SocketData[]
  closes: number
}

let warn: Mock<(...args: unknown[]) => void>
let warnings: string[]

beforeEach(() => {
  warnings = []
  warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')))
})

afterEach(() => warn.mockRestore())

/** Channels whose `openSocket` accepts every path, with the frames they send collected as a fake server would. */
function setup(open?: (opened: Opened) => void) {
  const frames: MachineFrame[] = []
  const opened: Opened[] = []
  const openSocket: OpenSocket = (_path, _headers, conn) => {
    const run: Opened = { conn, messages: [], closes: 0 }
    opened.push(run)
    open?.(run)
    return { message: (data) => run.messages.push(data), close: () => run.closes++ }
  }
  const channels = new TunnelChannels(openSocket, (frame) => frames.push(frame))
  const openChannel = (channel: number) => {
    channels.receive({ type: 'ws.open', channel, path: '/ws/events', headers: [] })
    const run = opened.at(-1)
    if (!run) throw new Error('not opened')
    return run
  }
  const of = <T extends MachineFrame['type']>(type: T) =>
    frames.filter((f): f is Extract<MachineFrame, { type: T }> => f.type === type)
  return { channels, frames, opened, openChannel, of }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('TunnelChannels', () => {
  test('delivers messages in order and acks exactly the payload bytes, ignoring frames for unknown channels', async () => {
    const { channels, openChannel, of, opened } = setup()
    const run = openChannel(1)
    const payloads: (string | Uint8Array<ArrayBuffer>)[] = [
      '{"type":"auth","key":"k"}',
      'héllo ✓',
      new Uint8Array([1, 2, 3]),
    ]
    for (const data of payloads) channels.receive({ type: 'ws.data', channel: 1, data })
    await tick()
    channels.receive({ type: 'ws.data', channel: 1, data: 'later' })
    await tick()

    expect(run.messages).toEqual([...payloads, 'later'])
    const acks = of('ws.ack')
    expect(acks.length).toBe(2)
    const total = [...payloads, 'later'].reduce((sum, data) => sum + wsPayloadBytes(data), 0)
    expect(acks.reduce((sum, ack) => sum + ack.bytes, 0)).toBe(total)

    channels.receive({ type: 'ws.data', channel: 9, data: 'x' })
    channels.receive({ type: 'ws.ack', channel: 9, bytes: 5 })
    channels.receive({ type: 'ws.close', channel: 9 })
    channels.receive({ type: 'ws.open', channel: 1, path: '/ws/events', headers: [] })
    await tick()
    expect(opened).toHaveLength(1)
    expect(of('ws.ack')).toHaveLength(2)
  })

  test('sends within the window, queues the rest in order, and follows the acks', () => {
    const { channels, openChannel, of } = setup()
    const { conn } = openChannel(1)
    const big = 'x'.repeat(WS_CHANNEL_WINDOW_BYTES - 10)
    // Under the window a message may start even when it then runs over.
    expect(conn.send(big)).toBe(big.length)
    expect(conn.send('0123456789ab')).toBe(12)
    expect(conn.send('queued-1')).toBe(-1)
    expect(conn.send(new Uint8Array(4))).toBe(-1)
    expect(conn.buffered()).toBe(big.length + 12 + 8 + 4)
    expect(of('ws.data')).toHaveLength(2)

    channels.receive({ type: 'ws.ack', channel: 1, bytes: big.length })
    const data = of('ws.data').map((f) => f.data)
    expect(data.slice(2)).toEqual(['queued-1', new Uint8Array(4)])
    expect(conn.buffered()).toBe(12 + 8 + 4)
  })

  test('marks a terminal stale while acks are held back, and lets it resync once they arrive', () => {
    let client: TermClient | undefined
    const { channels, openChannel, of } = setup(({ conn }) => {
      client = {
        ready: true,
        queue: [],
        queued: 0,
        stale: false,
        want: null,
        answers: false,
        send: (data) => conn.send(data),
        buffered: () => conn.buffered(),
      }
    })
    openChannel(1)
    if (!client) throw new Error('no client')
    const chunk = new Uint8Array(32 * 1024)
    for (let i = 0; i < 40 && !client.stale; i++) deliver(client, chunk)
    expect(client.stale).toBe(true)
    expect(client.buffered()).toBeGreaterThan(1024 * 1024)

    // The fake server now acks all it has been sent, as the browser takes it.
    let acked = 0
    while (client.buffered() >= CAUGHT_UP) {
      const sent = of('ws.data').reduce((sum, f) => sum + wsPayloadBytes(f.data), 0)
      if (sent === acked) throw new Error('the queue stopped moving')
      channels.receive({ type: 'ws.ack', channel: 1, bytes: sent - acked })
      acked = sent
    }
    expect(client.buffered()).toBeLessThan(CAUGHT_UP)
  })

  test('closes a channel whose queue passes the cap with 1011, and one with an oversized message with 1009', () => {
    const { channels, openChannel, of } = setup()
    const slow = openChannel(1)
    const chunk = 'y'.repeat(256 * 1024)
    const results: number[] = []
    const queued = CHANNEL_QUEUE_CAP_BYTES / chunk.length
    for (let i = 0; i < queued + 2; i++) results.push(slow.conn.send(chunk))
    // One goes out within the window, the queue fills to the cap, and the next message closes the channel.
    expect(results).toEqual([chunk.length, ...Array(queued).fill(-1), 0])
    expect(slow.closes).toBe(1)
    expect(of('ws.close')).toEqual([{ type: 'ws.close', channel: 1, code: 1011, reason: 'too far behind' }])
    expect(slow.conn.send('more')).toBe(0)

    const big = openChannel(2)
    const secret = 'z'.repeat(2 * 1024 * 1024)
    expect(big.conn.send(secret)).toBe(0)
    expect(big.closes).toBe(1)
    expect(of('ws.close')[1]).toEqual({ type: 'ws.close', channel: 2, code: 1009, reason: 'message too big' })
    expect(warnings.some((line) => line.includes('does not fit'))).toBe(true)
    expect(warnings.join('\n')).not.toContain('zzzz')
    expect(channels.size).toBe(0)
  })

  test('ends a channel the server closes, and every channel when the tunnel goes, sending nothing', () => {
    const { channels, openChannel, frames } = setup()
    const a = openChannel(1)
    const b = openChannel(2)
    const c = openChannel(3)
    a.conn.send('x'.repeat(WS_CHANNEL_WINDOW_BYTES))
    a.conn.send('queued')
    const before = frames.length

    channels.receive({ type: 'ws.close', channel: 1, code: 1000 })
    channels.receive({ type: 'ws.ack', channel: 1, bytes: WS_CHANNEL_WINDOW_BYTES })
    channels.close()
    channels.close()
    b.conn.close(1000)
    expect(c.conn.send('late')).toBe(0)
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/events', headers: [] })

    expect([a.closes, b.closes, c.closes]).toEqual([1, 1, 1])
    expect(frames.length).toBe(before)
    expect(channels.size).toBe(0)
  })
})
