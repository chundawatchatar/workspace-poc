import { describe, expect, test } from 'bun:test'
import { CLOSE_MACHINE_OFFLINE, MAX_TUNNEL_FRAME_BYTES, type ServerFrame, WS_CHANNEL_WINDOW_BYTES } from '@orch/shared'
import { type MachineConnection, MachineRegistry } from '../tunnel/tunnel.service'
import { type BrowserSocket, ChannelBridge } from './bridge.service'

/** A fake browser socket. `backpressured` makes `send` report backpressure. */
interface FakeSocket extends BrowserSocket {
  received: (string | Uint8Array)[]
  closes: [number, string][]
  backpressured: boolean
}

function socket(): FakeSocket {
  const fake: FakeSocket = {
    received: [],
    closes: [],
    backpressured: false,
    send: (data) => {
      fake.received.push(data)
      return !fake.backpressured
    },
    close: (code, reason) => {
      fake.closes.push([code, reason])
    },
  }
  return fake
}

/** A bridge with fake machines `m1` and `m2` whose sent frames are recorded. */
function setup(maxChannelsPerMachine?: number) {
  const registry = new MachineRegistry()
  const sent: Record<string, ServerFrame[]> = { m1: [], m2: [] }
  const conn = (machineId: string): MachineConnection => {
    const live = { machineId, send: (frame: ServerFrame) => sent[machineId]?.push(frame), close: () => {} }
    registry.register(live)
    return live
  }
  const m1 = conn('m1')
  const m2 = conn('m2')
  const bridge = new ChannelBridge({ registry, maxChannelsPerMachine })
  const open = (machineId = 'm1') => {
    const browser = socket()
    const channel = bridge.open(machineId, '/ws/term/a', [['x-a', '1']], browser)
    return { browser, channel }
  }
  return { bridge, sent, m1, m2, open }
}

const kib = (n: number) => new Uint8Array(n * 1024)

describe('ChannelBridge', () => {
  test('stops sending at the window, resumes in order after an ack, and closes when the queue outgrows the window', () => {
    const { bridge, sent, m1, open } = setup()
    const { browser, channel } = open()
    const quarter = WS_CHANNEL_WINDOW_BYTES / 4 / 1024
    for (let i = 0; i < 6; i++) channel?.message(kib(quarter).fill(i))
    const data = () => sent.m1?.filter((f) => f.type === 'ws.data').map((f) => f.type === 'ws.data' && f.data[0])
    // The window takes four messages; the fifth and sixth wait for credit.
    expect(data()).toEqual([0, 1, 2, 3])

    bridge.handleFrame(m1, { type: 'ws.ack', channel: 1, bytes: quarter * 1024 })
    expect(data()).toEqual([0, 1, 2, 3, 4])
    bridge.handleFrame(m1, { type: 'ws.ack', channel: 1, bytes: 2 * quarter * 1024 })
    expect(data()).toEqual([0, 1, 2, 3, 4, 5])

    // A machine that never acks again: the queue may hold one window, then the channel closes.
    for (let i = 0; i < 6; i++) channel?.message(kib(quarter))
    expect(browser.closes).toEqual([[1008, 'window exceeded']])
    expect(sent.m1?.at(-1)).toEqual({ type: 'ws.close', channel: 1, code: 1008, reason: 'window exceeded' })
    expect(bridge.size).toBe(0)
  })

  test('a single message larger than the window still goes through, but not one that overflows a frame', () => {
    const { bridge, sent, open } = setup()
    const { browser, channel } = open()
    channel?.message(kib(WS_CHANNEL_WINDOW_BYTES / 1024 + 1))
    expect(sent.m1?.filter((f) => f.type === 'ws.data')).toHaveLength(1)

    const second = open()
    second.channel?.message(new Uint8Array(MAX_TUNNEL_FRAME_BYTES - 10))
    expect(second.browser.closes).toEqual([[1009, 'message too big']])
    expect(sent.m1?.at(-1)).toEqual({ type: 'ws.close', channel: 2, code: 1009, reason: 'message too big' })
    expect(sent.m1?.filter((f) => f.type === 'ws.data')).toHaveLength(1)
    expect(browser.closes).toEqual([])
    expect(bridge.size).toBe(1)
  })

  test('acks machine data at once, holds acks while the browser is backpressured, and closes a machine past its window', () => {
    const { bridge, sent, m1, open } = setup()
    const slow = open()
    const other = open()
    const acks = () => sent.m1?.filter((f) => f.type === 'ws.ack')

    bridge.handleFrame(m1, { type: 'ws.data', channel: 1, data: 'héllo' })
    expect(acks()).toEqual([{ type: 'ws.ack', channel: 1, bytes: 6 }])

    slow.browser.backpressured = true
    const chunk = kib(WS_CHANNEL_WINDOW_BYTES / 1024 / 2)
    bridge.handleFrame(m1, { type: 'ws.data', channel: 1, data: chunk })
    slow.browser.backpressured = false
    bridge.handleFrame(m1, { type: 'ws.data', channel: 1, data: 'x' })
    expect(acks()).toHaveLength(1)
    slow.channel?.drained()
    expect(acks()?.at(-1)).toEqual({ type: 'ws.ack', channel: 1, bytes: chunk.byteLength + 1 })

    slow.browser.backpressured = true
    for (let i = 0; i < 3; i++) bridge.handleFrame(m1, { type: 'ws.data', channel: 1, data: chunk })
    expect(slow.browser.received).toHaveLength(5)
    expect(slow.browser.closes).toEqual([[1011, 'window exceeded']])
    expect(sent.m1?.at(-1)).toEqual({ type: 'ws.close', channel: 1, code: 1011, reason: 'window exceeded' })

    bridge.handleFrame(m1, { type: 'ws.data', channel: 2, data: 'still here' })
    expect(other.browser.received).toEqual(['still here'])
    expect(other.browser.closes).toEqual([])
  })

  test('closes pass through both ways once, and foreign or late frames are ignored', () => {
    const { bridge, sent, m1, m2, open } = setup()
    const a = open()
    const b = open()
    const c = open()
    const d = open()

    a.channel?.closed(4001, 'bye')
    b.channel?.closed(1005, '')
    expect(sent.m1?.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: 4001, reason: 'bye' },
      { type: 'ws.close', channel: 2 },
    ])

    bridge.handleFrame(m2, { type: 'ws.close', channel: 3, code: 4000 })
    bridge.handleFrame(m1, { type: 'ws.close', channel: 3, code: 4000, reason: 'done' })
    bridge.handleFrame(m1, { type: 'ws.close', channel: 4, code: 1006 })
    expect(c.browser.closes).toEqual([[4000, 'done']])
    expect(d.browser.closes).toEqual([[1000, '']])
    c.channel?.closed(4000, 'done')
    expect(sent.m1?.filter((f) => f.type === 'ws.close')).toHaveLength(2)

    bridge.handleFrame(m1, { type: 'ws.data', channel: 3, data: 'late' })
    bridge.handleFrame(m1, { type: 'ws.ack', channel: 99, bytes: 1 })
    expect(c.browser.received).toEqual([])
    expect(bridge.size).toBe(0)
  })

  test('refuses sockets for an offline or full machine, and closes every channel when its tunnel closes', () => {
    const { bridge, sent, m1, open } = setup(2)
    const offline = open('nobody')
    expect(offline.channel).toBeNull()
    expect(offline.browser.closes).toEqual([[CLOSE_MACHINE_OFFLINE, 'machine offline']])

    const a = open()
    const b = open()
    const full = open()
    expect(full.channel).toBeNull()
    expect(full.browser.closes).toEqual([[1013, 'too many channels']])
    expect(sent.m1?.map((f) => f.type === 'ws.open' && [f.channel, f.path])).toEqual([
      [1, '/ws/term/a'],
      [2, '/ws/term/a'],
    ])

    bridge.connectionClosed(m1)
    expect(a.browser.closes).toEqual([[CLOSE_MACHINE_OFFLINE, 'machine offline']])
    expect(b.browser.closes).toEqual([[CLOSE_MACHINE_OFFLINE, 'machine offline']])
    a.channel?.closed(CLOSE_MACHINE_OFFLINE, 'machine offline')
    a.channel?.message('after')
    expect(sent.m1).toHaveLength(2)
    expect(sent.m2).toHaveLength(0)
    expect(bridge.size).toBe(0)
    // The closed tunnel stays in the registry until its close event, but takes no new channels.
    expect(open().channel).toBeNull()
  })
})
