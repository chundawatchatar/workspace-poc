import { describe, expect, test } from 'bun:test'
import { AgentChannel, type AgentTracking, agentSocketPath } from './agent-channel'

const both: AgentTracking = { claude: true, codex: true }
const none: AgentTracking = { claude: false, codex: false }
const tool = { agent: 'claude', state: 'working', reason: 'tool' }
const finished = { agent: 'claude', state: 'idle', reason: 'finished' }
const permission = { agent: 'claude', state: 'waiting', reason: 'permission' }

/** A channel on a clock the test moves, with helpers that speak to it as a shell would. */
function setup() {
  const clock = { now: 1000 }
  const changes: string[] = []
  const notes: string[] = []
  const logs: string[] = []
  const channel = new AgentChannel(
    (id) => changes.push(id),
    (id, message) => notes.push(`${id}: ${message}`),
    (message) => logs.push(message),
    () => clock.now,
  )
  channel.open('/run/agent.sock')
  const start = (id: string, tracking = both) => {
    channel.setTracking(id, tracking)
    return channel.issue(id)?.token ?? ''
  }
  const post = (token: string | null, body: unknown, init: RequestInit = {}) =>
    channel.handle(
      new Request('http://agent/v1/state', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      }),
    )
  const session = (token: string | null) =>
    channel.handle(
      new Request('http://agent/v1/session', { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    )
  return { clock, changes, notes, logs, channel, start, post, session }
}

/** Sends `count` events and gives their statuses. */
async function burst(post: ReturnType<typeof setup>['post'], token: string, count: number, body: unknown = tool) {
  const statuses: number[] = []
  for (let i = 0; i < count; i++) statuses.push((await post(token, body)).status)
  return statuses
}

describe('tokens', () => {
  test('each shell gets its own token, and only a tracked session with a bound socket gets one', () => {
    const { channel, start } = setup()
    const a = start('a')
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(start('b')).not.toBe(a)
    channel.setTracking('off', none)
    expect(channel.issue('off')).toBeNull()

    const unbound = new AgentChannel(
      () => {},
      () => {},
    )
    unbound.setTracking('a', both)
    expect(unbound.issue('a')).toBeNull()
    expect(agentSocketPath('/tmp/x/host.sock')).toBe('/tmp/x/agent.sock')
  })

  test('a token ends with its shell, its session or tracking, and turning tracking on gives no running shell one', async () => {
    const { channel, start, post, session } = setup()
    const exited = start('exited')
    await post(exited, tool)
    channel.shellExited('exited')
    expect(channel.hook('exited')).toBeNull()
    expect((await session(exited)).status).toBe(401)
    expect(channel.issue('exited')?.token).not.toBe(exited)

    const closed = start('closed')
    channel.close('closed')
    expect((await session(closed)).status).toBe(401)

    const off = start('off')
    await post(off, tool)
    channel.setTracking('off', none)
    expect(channel.hook('off')).toBeNull()
    expect((await session(off)).status).toBe(401)
    channel.setTracking('off', both)
    expect((await session(off)).status).toBe(401)
    expect((await post(off, tool)).status).toBe(401)
  })
})

describe('events', () => {
  test('a valid event answers 204 and sets the hook state at its arrival time, and the session answers its tracking', async () => {
    const { clock, changes, channel, start, post, session } = setup()
    const token = start('a', { claude: true, codex: false })
    clock.now = 5000
    const response = await post(token, tool)
    expect(response.status).toBe(204)
    expect(channel.hook('a')).toEqual({ agent: 'claude', state: 'working', reason: 'tool', at: 5000 })
    expect(changes).toEqual(['a'])

    const answer = await session(token)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ claude: true, codex: false })

    await post(token, { agent: 'claude', state: 'idle', reason: 'exited' })
    expect(channel.hook('a')).toBeNull()
  })

  test('a working / tool keeps away from a fresh waiting, while a waiting always replaces a working', async () => {
    const { clock, channel, start, post } = setup()
    const token = start('a')
    await post(token, tool)
    await post(token, permission)
    expect(channel.hook('a')?.state).toBe('waiting')
    clock.now += 999
    expect((await post(token, tool)).status).toBe(204)
    expect(channel.hook('a')?.state).toBe('waiting')
    clock.now += 1
    await post(token, tool)
    expect(channel.hook('a')?.state).toBe('working')
    await post(token, permission)
    await post(token, { agent: 'claude', state: 'working', reason: 'prompt' })
    expect(channel.hook('a')?.reason).toBe('prompt')
  })

  test('after agentExited the hook state is gone and late events are dropped for a second, except started', async () => {
    const { clock, channel, start, post } = setup()
    const token = start('a')
    await post(token, tool)
    channel.agentExited('a')
    expect(channel.hook('a')).toBeNull()
    expect((await post(token, finished)).status).toBe(204)
    expect(channel.hook('a')).toBeNull()
    await post(token, { agent: 'claude', state: 'idle', reason: 'started' })
    expect(channel.hook('a')?.reason).toBe('started')
    channel.agentExited('a')
    clock.now += 1000
    await post(token, finished)
    expect(channel.hook('a')?.reason).toBe('finished')
  })
})

describe('notifications', () => {
  const event = (state: string, reason: string, agent = 'claude') => ({ agent, state, reason })

  test('Claude Code notifies once per finished, permission or question transition, and for nothing else', async () => {
    const { clock, notes, start, post } = setup()
    const token = start('a')
    const steps: [ReturnType<typeof event>, string | null][] = [
      [event('idle', 'started'), null],
      [event('idle', 'finished'), null],
      [event('working', 'prompt'), null],
      [event('waiting', 'permission'), 'needs permission'],
      [event('waiting', 'permission'), null],
      [event('working', 'tool'), null],
      [event('waiting', 'question'), 'has a question'],
      [event('waiting', 'question'), null],
      [event('waiting', 'permission'), 'needs permission'],
      [event('waiting', 'question'), 'has a question'],
      [event('idle', 'finished'), 'finished'],
      [event('idle', 'finished'), null],
      // `idle_prompt`, about a minute after `Stop`.
      [event('waiting', 'question'), null],
      [event('working', 'prompt'), null],
      [event('idle', 'finished'), 'finished'],
      [event('waiting', 'permission'), 'needs permission'],
      [event('idle', 'finished'), 'finished'],
      [event('idle', 'exited'), null],
    ]
    for (const [body, expected] of steps) {
      clock.now += 2000
      const before = notes.length
      expect((await post(token, body)).status).toBe(204)
      expect(notes.slice(before)).toEqual(expected ? [`a: Claude Code ${expected}`] : [])
    }
  })

  test('an event the channel drops raises nothing', async () => {
    const { clock, notes, channel, start, post } = setup()
    const token = start('a')
    await post(token, tool)
    channel.agentExited('a')
    await post(token, permission)
    await post(token, finished)

    clock.now += 1000
    await post(token, tool)
    await burst(post, token, 19)
    expect((await post(token, permission)).status).toBe(429)
    expect((await post(token, tool)).status).toBe(429)
    clock.now += 1000
    channel.tick()
    expect(channel.hook('a')?.state).toBe('working')

    channel.setTracking('a', { claude: false, codex: true })
    expect((await post(token, permission)).status).toBe(400)
    expect(notes).toEqual([])
  })

  test('Codex notifies each finished turn except the first of an agent run, the title turn', async () => {
    const { clock, notes, channel, start, post } = setup()
    const codex = event('idle', 'finished', 'codex')
    const finishes = async (token: string, count: number) => {
      const before = notes.length
      for (let i = 0; i < count; i++) await post(token, codex)
      return notes.slice(before)
    }
    const token = start('a')
    expect(await finishes(token, 3)).toEqual(['a: Codex finished', 'a: Codex finished'])

    channel.agentExited('a')
    clock.now += 1000
    expect(await finishes(token, 2)).toEqual(['a: Codex finished'])

    channel.setTracking('a', { claude: true, codex: false })
    channel.setTracking('a', both)
    expect(await finishes(token, 2)).toEqual(['a: Codex finished'])

    const renewed = start('a')
    expect(await finishes(renewed, 2)).toEqual(['a: Codex finished'])
  })
})

describe('rejected requests', () => {
  test('a missing or unknown token gets 401, and one session never changes another', async () => {
    const { channel, start, post, session } = setup()
    const a = start('a')
    const b = start('b')
    expect((await post(null, tool)).status).toBe(401)
    expect((await post('f'.repeat(64), tool)).status).toBe(401)
    expect((await session(null)).status).toBe(401)
    expect(channel.hook('a')).toBeNull()
    await post(b, tool)
    expect(channel.hook('b')).not.toBeNull()
    expect(channel.hook('a')).toBeNull()
    await post(a, permission)
    expect(channel.hook('b')?.state).toBe('working')
  })

  test('bad bodies get 400 with a fixed error that repeats nothing of the input', async () => {
    const { channel, start, post } = setup()
    const token = start('a', { claude: true, codex: false })
    const bodies = [
      { ...tool, prompt: 'secret' },
      { ...tool, sessionId: 'secret' },
      { ...tool, tool: 'secret' },
      { ...tool, reason: 'secret' },
      { ...tool, agent: 'cursor' },
      { ...tool, agent: 'codex' },
      'secret {',
      '',
    ]
    for (const body of bodies) {
      const response = await post(token, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('{"error":"bad_request"}')
    }
    expect(channel.hook('a')).toBeNull()
  })

  test('a body over 256 bytes gets 413, with or without Content-Length', async () => {
    const { channel, start, post } = setup()
    const token = start('a')
    const big = 'x'.repeat(257)
    expect((await post(token, big)).status).toBe(413)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big.slice(0, 200)))
        controller.enqueue(new TextEncoder().encode(big.slice(200)))
        controller.close()
      },
    })
    const response = await post(token, 'ignored', { body: stream })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too_large' })
    expect((await post('f'.repeat(64), big)).status).toBe(401)
    expect(channel.hook('a')).toBeNull()
  })

  test('any other method or path gets 404', async () => {
    const { channel, start } = setup()
    const headers = { authorization: `Bearer ${start('a')}` }
    const requests = [
      new Request('http://agent/v1/state', { headers }),
      new Request('http://agent/v1/session', { method: 'POST', headers }),
      new Request('http://agent/v1/other', { headers }),
      new Request('http://agent/', { method: 'DELETE', headers }),
    ]
    for (const request of requests) {
      const response = await channel.handle(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
  })
})

describe('rate limit', () => {
  test('a burst over 20 gets 429 without changing the state, and room comes back with time', async () => {
    const { clock, channel, start, post } = setup()
    const token = start('a')
    expect(await burst(post, token, 20)).toEqual(Array(20).fill(204))
    const at = channel.hook('a')?.at
    clock.now += 1
    const refused = await post(token, permission)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    expect(channel.hook('a')).toMatchObject({ state: 'working', at })
    clock.now += 99
    expect((await post(token, tool)).status).toBe(204)
    expect((await post(token, tool)).status).toBe(429)
  })

  test('the newest refused event lands once there is room, unless the token was forgotten first', async () => {
    const { clock, channel, start, post } = setup()
    const token = start('a')
    await burst(post, token, 25)
    expect((await post(token, finished)).status).toBe(429)
    channel.tick()
    expect(channel.hook('a')?.state).toBe('working')
    clock.now += 100
    channel.tick()
    expect(channel.hook('a')).toMatchObject({ state: 'idle', reason: 'finished', at: 1000 })

    const gone = start('gone')
    await burst(post, gone, 21)
    channel.shellExited('gone')
    clock.now += 1000
    channel.tick()
    expect(channel.hook('gone')).toBeNull()
  })

  test('a flood on one session leaves the others alone until the shared limit of 200', async () => {
    const { clock, start, post } = setup()
    const tokens = Array.from({ length: 25 }, (_, index) => start(`s${index}`))
    const flooded = await burst(post, tokens[0] ?? '', 40)
    expect(flooded.filter((status) => status === 204)).toHaveLength(20)
    const others: number[][] = []
    for (const token of tokens.slice(1)) others.push(await burst(post, token, 20))
    expect(others.flat().filter((status) => status === 204)).toHaveLength(180)
    expect(others.at(-1)?.every((status) => status === 429)).toBe(true)
    clock.now += 100
    expect((await post(tokens.at(-1) ?? '', tool)).status).toBe(204)
  })

  test('dropped events are logged once a minute as a count per session, without the token', async () => {
    const { clock, logs, channel, start, post } = setup()
    const token = start('a')
    await burst(post, token, 23)
    channel.tick()
    expect(logs).toEqual([])
    clock.now += 60_000
    channel.tick()
    channel.tick()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('3 event(s) for a')
    expect(logs[0]).not.toContain(token)
  })
})
