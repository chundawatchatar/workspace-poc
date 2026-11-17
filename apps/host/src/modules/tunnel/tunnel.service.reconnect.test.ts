import { afterEach, beforeEach, describe, expect, jest, type Mock, spyOn, test } from 'bun:test'
import {
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  machineFrame,
  type ServerFrame,
} from '@orch/shared'
import { TunnelClient } from './tunnel.service'
import { createTestMachineKey, testNonce } from './tunnel.testing'

// The wake watchdog and the pong timeout, under fake timers with a fake socket.
// The real-server tests are in `tunnel.service.test.ts`.

const key = createTestMachineKey()

let clients: TunnelClient[]
let logs: string[]
let spies: Mock<(...args: unknown[]) => void>[]
let sockets: FakeSocket[]
let seen: string[]

beforeEach(() => {
  jest.useFakeTimers()
  clients = []
  logs = []
  sockets = []
  seen = []
  spies = (['log', 'error', 'warn'] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(' '))),
  )
})

afterEach(() => {
  for (const client of clients) client.stop()
  jest.useRealTimers()
  for (const spy of spies) spy.mockRestore()
  expect(logs.join('\n')).not.toContain(key.privateKey)
})

/** A tunnel socket the test drives by hand, so the client can run under fake timers. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  binaryType = 'blob'
  bufferedAmount = 0
  frames: MachineFrame[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string | Uint8Array) {
    const frame = decodeFrame(machineFrame, data)
    if (frame) this.frames.push(frame)
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.readyState = WebSocket.CLOSED
  }

  /** Opens the socket, challenges the client and welcomes it. */
  welcome() {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
    this.receive({ type: 'challenge', nonce: testNonce() })
    this.receive({ type: 'welcome', machineId: 'm' })
  }

  receive(frame: ServerFrame) {
    this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(frame) }))
  }

  /** Ends the socket from the server's side, or as a failed dial. */
  end(code = 1006) {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code }))
  }

  /** Answers every ping not answered yet. */
  pong() {
    for (const frame of this.frames.splice(0))
      if (frame.type === 'ping') this.receive({ type: 'pong', nonce: frame.nonce })
  }
}

describe('TunnelClient wake and pong checks', () => {
  /** A client with the default timings and the jitter pinned to the top of the window. */
  function startFake() {
    const client = new TunnelClient({
      url: 'ws://127.0.0.1:1/tunnel',
      key,
      authorize: () => ({ kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 4_102_444_800 }),
      handle: async () => new Response('ok'),
      openSocket: () => ({ code: 1008, reason: 'no sockets here' }),
      random: () => 1,
      onStatus: (state) => seen.push(state),
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    clients.push(client)
    client.start()
    return client
  }

  function sleep(ms: number) {
    jest.setSystemTime(Date.now() + ms)
  }

  test('a wake replaces a connected socket at once and keeps the backoff where it was', () => {
    startFake()
    sockets[0]?.end()
    jest.advanceTimersByTime(1000)
    sockets[1]?.welcome()
    expect(seen).toEqual(['connecting', 'reconnecting', 'connecting', 'connected'])

    sleep(60_000)
    jest.advanceTimersByTime(1000)
    expect(sockets[1]?.closed).toEqual({ code: 1000, reason: 'woke from sleep' })
    expect(sockets).toHaveLength(3)
    expect(seen.slice(3)).toEqual(['connected', 'reconnecting', 'connecting'])

    // One dial failed before the wake, so the next delay is the second step, not the first or the third.
    sockets[2]?.end()
    expect(logs.at(-1)).toBe('tunnel lost (closed with 1006), reconnecting in 2000 ms')
  })

  test('a wake during backoff dials at once and leaves the attempt counter alone', () => {
    startFake()
    for (const delay of [1000, 2000, 4000]) {
      sockets.at(-1)?.end()
      jest.advanceTimersByTime(delay)
    }
    sockets.at(-1)?.end()
    expect(logs.at(-1)).toBe('tunnel lost (closed with 1006), reconnecting in 8000 ms')

    sleep(60_000)
    jest.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(5)
    // Without the wake, the dial after the 8000 ms wait would also have been followed by 16000 ms.
    sockets.at(-1)?.end()
    expect(logs.at(-1)).toBe('tunnel lost (closed with 1006), reconnecting in 16000 ms')
    jest.advanceTimersByTime(15_999)
    expect(sockets).toHaveLength(5)
    jest.advanceTimersByTime(1)
    expect(sockets).toHaveLength(6)
  })

  test('keeps a live connection through ten minutes and a backward clock change, and drops one that misses a pong', () => {
    startFake()
    const socket = sockets[0]
    socket?.welcome()
    for (let second = 0; second < 600; second++) {
      if (second === 300) jest.setSystemTime(Date.now() - 3_600_000)
      jest.advanceTimersByTime(1000)
      socket?.pong()
    }
    expect(sockets).toHaveLength(1)
    expect(socket?.closed).toBeNull()

    // The next ping goes unanswered; the server's own frames don't count as its pong.
    jest.advanceTimersByTime(20_000)
    expect(socket?.frames.some((frame) => frame.type === 'ping')).toBe(true)
    socket?.receive({ type: 'ping', nonce: 1 })
    socket?.receive({ type: 'pong', nonce: -1 })
    jest.advanceTimersByTime(4999)
    expect(socket?.closed).toBeNull()
    jest.advanceTimersByTime(1)
    expect(socket?.closed).toEqual({ code: 1000, reason: 'missed pong' })
    expect(logs.at(-1)).toMatch(/^tunnel lost \(missed pong\), reconnecting in \d+ ms$/)
    expect(sockets).toHaveLength(1)
  })

  test('leaves no timer and dials nothing after stop or a final close', () => {
    for (const end of [
      (client: TunnelClient) => client.stop(),
      () => sockets.at(-1)?.end(CLOSE_REPLACED),
      () => sockets.at(-1)?.end(CLOSE_UNSUPPORTED_VERSION),
    ]) {
      const client = startFake()
      sockets.at(-1)?.welcome()
      end(client)
      const count = sockets.length
      sleep(60_000)
      jest.advanceTimersByTime(120_000)
      expect(sockets).toHaveLength(count)
      expect(jest.getTimerCount()).toBe(0)
    }
  })
})
