import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import {
  decodeFrame,
  encodeFrame,
  machinePathPrefix,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server } from 'bun'
import { eq } from 'drizzle-orm'
import { serverWebSocket } from '../../lib/websocket'
import { accountsTestApp, cookiePair } from '../auth/auth.testing'
import { ConnectionLimiter } from '../limits/limits.service'
import { machineIdFromProof } from '../tunnel/tunnel.service'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>
let server: Server<unknown>
const sockets: WebSocket[] = []

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.9.0', {
    // Every test tunnel comes from 127.0.0.1, so the per-IP upgrade limit is lifted.
    limiter: new ConnectionLimiter({ tunnelPerIp: { capacity: 1000, refillEveryMs: 1 } }),
  })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => ctx.app.fetch(request, bunServer),
    websocket: serverWebSocket,
  })
})

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close()
})

afterAll(async () => {
  await server.stop(true)
  await domain.close()
})

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

type RelayFrame = Extract<ServerFrame, { type: 'http.request' | 'ws.open' }>

/** A welcomed test machine that answers every request with 204 and records what the relay sent it. */
async function machine() {
  const proof = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  sockets.push(ws)
  const relayed: RelayFrame[] = []
  let welcomed = false
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame?.type === 'welcome') welcomed = true
    if (frame?.type === 'http.request') {
      relayed.push(frame)
      ws.send(encodeFrame({ type: 'http.response', id: frame.id, status: 204, headers: [] }))
      ws.send(encodeFrame({ type: 'http.end', id: frame.id }))
    }
    if (frame?.type === 'ws.open') relayed.push(frame)
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  ws.send(encodeFrame({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof }))
  await until(() => welcomed)
  return { machineId: machineIdFromProof(proof), relayed }
}

interface User {
  userId: string
  ip: string
  cookie: string
}

async function signedIn(): Promise<User> {
  const email = ctx.client.freshEmail()
  const ip = ctx.client.freshIp()
  const cookie = cookiePair(await ctx.client.verifiedUser(email, ip))
  const [row] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
  return { userId: row?.id as string, ip, cookie }
}

/**
 * Sends one HTTP request and opens one socket to `machineId` through the relay,
 * with `cookie` when given, and returns the two frames the machine got.
 */
async function relay(box: Awaited<ReturnType<typeof machine>>, cookie?: string): Promise<RelayFrame[]> {
  const before = box.relayed.length
  const headers = cookie ? { cookie } : undefined
  const base = `127.0.0.1:${server.port}${machinePathPrefix(box.machineId)}`
  const response = await fetch(`http://${base}/api/system/health`, { headers })
  expect(response.status).toBe(204)
  const ws = new WebSocket(`ws://${base}/ws/events`, headers ? { headers } : undefined)
  sockets.push(ws)
  await until(() => box.relayed.length === before + 2)
  return box.relayed.slice(before)
}

const hasCookie = (frame: RelayFrame) => frame.headers.some(([name]) => name.toLowerCase() === 'cookie')

describe('relay account', () => {
  test('a request and a socket carry the account id only for a signed-in user who lists the machine', async () => {
    const ada = await signedIn()
    const bob = await signedIn()
    const box = await machine()
    const linked = await ctx.client.call('POST', '/api/machines', {
      ...ada,
      body: { machineId: box.machineId, name: 'Box' },
    })
    expect(linked.status).toBe(200)

    const asAda = await relay(box, ada.cookie)
    expect(asAda.map((frame) => [frame.type, frame.accountId])).toEqual([
      ['http.request', ada.userId],
      ['ws.open', ada.userId],
    ])
    expect(asAda.some(hasCookie)).toBe(false)

    // Signed out, and signed in to an account that doesn't list the machine.
    for (const cookie of [undefined, bob.cookie]) {
      const frames = await relay(box, cookie)
      expect(frames.map((frame) => frame.accountId)).toEqual([undefined, undefined])
      expect(frames.some(hasCookie)).toBe(false)
    }

    // A revoked session attaches nothing on its next request.
    const signOut = await ctx.client.call('POST', '/api/auth/sign-out', ada)
    expect(signOut.status).toBe(200)
    const revoked = await relay(box, ada.cookie)
    expect(revoked.map((frame) => frame.accountId)).toEqual([undefined, undefined])
  })
})
