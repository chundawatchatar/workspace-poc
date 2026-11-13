import { describe, expect, test } from 'bun:test'
import { buildSocketUrl, routes } from '@orch/shared'
import {
  clients,
  dataOn,
  device,
  key,
  machineId,
  OUTPUT,
  openE2eSession,
  send,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { openMessages, sealedSocketEnvelope, sealMessage } from './modules/tunnel/tunnel.testing'

// Sockets sealed end to end, on the harness in `app.tunnel.testing.ts`. The
// handshake and sealed requests are in `app.tunnel.test.ts`, which is full.
useTunnelHarness()

describe('tunneled sealed sockets', () => {
  test('a sealed events socket says hello and a sealed terminal socket takes input, as the session principal', async () => {
    const conn = await welcomed()
    const { session, sessionId } = await openE2eSession(conn, 1)
    const eventsPath = buildSocketUrl(routes.sockets.events, {})
    const events = await sealedSocketEnvelope(session, sessionId, 2, {
      path: eventsPath,
      auth: { type: 'auth', key, device: await device.socket(machineId, eventsPath) },
    })
    send(conn, { type: 'ws.sealed', channel: 1, data: events.data })
    const termPath = buildSocketUrl(routes.sockets.terminal, { id: 't1', cwd: '/tmp', cols: 80, rows: 24 })
    const term = await sealedSocketEnvelope(session, sessionId, 3, {
      path: termPath,
      auth: { type: 'auth', key, device: await device.socket(machineId, termPath) },
    })
    send(conn, { type: 'ws.sealed', channel: 2, data: term.data })
    await until(() => dataOn(conn, 1).length > 0 && dataOn(conn, 2).length >= 2)

    const [hello] = await openMessages(events.channel, dataOn(conn, 1))
    expect(JSON.parse(String(hello))).toMatchObject({ type: 'hello' })
    const [snapshot, output] = await openMessages(term.channel, dataOn(conn, 2).slice(0, 2))
    expect([snapshot, output]).toEqual([JSON.stringify({ type: 'snapshot' }), OUTPUT])
    send(conn, {
      type: 'ws.data',
      channel: 2,
      data: await sealMessage(term.channel, '{"type":"input","data":"ls\\n"}'),
    })
    await until(() => stub.inputs.length > 0)
    expect(stub.inputs).toEqual(['ls\n'])
    expect(clients[0]?.listChannels().map((c) => c.principal)).toEqual([
      expect.objectContaining({ kind: 'key', deviceId: device.id }),
      expect.objectContaining({ kind: 'key', deviceId: device.id }),
    ])
    const sent = [...dataOn(conn, 1), ...dataOn(conn, 2)]
    expect(sent.every((data) => data instanceof Uint8Array)).toBe(true)
    const clear = Buffer.concat(sent as Uint8Array[]).toString('latin1')
    expect(['"hello"', 'snapshot'].some((text) => clear.includes(text))).toBe(false)
  })
})
