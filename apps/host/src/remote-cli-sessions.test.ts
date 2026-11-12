import { describe, expect, test } from 'bun:test'
import {
  type Endpoint,
  formatLocalDateTime,
  type RemoteAccessStatus,
  routes,
  type SessionsResponse,
} from '@orch/shared'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { type CallHost, type HostAnswer, runRemote } from './remote-cli'

const status: RemoteAccessStatus = {
  enabled: true,
  serverUrl: 'wss://orch.example.com',
  serverUrlIsDefault: true,
  clientUrl: null,
  serverUrlFromEnv: false,
  clientUrlFromEnv: false,
  machineId: 'm1',
  machineFingerprint: 'ABCD-EFGH-JKMN-PQRS',
  tunnel: 'connected',
  linkedAccount: null,
}
const alice = `1${'d'.repeat(42)}`
const bob = `2${'d'.repeat(42)}`
const startedAt = '2026-11-06T12:00:00.000Z'

/**
 * Runs `host:remote` against a host that answers `status` and then `sessions`
 * with `answer`, or against no host at all when `answer` is null. Answers the
 * exit code, what it printed, and the endpoints it called.
 */
async function run(args: string[], answer: HostAnswer<typeof routes.remoteAccess.sessions> | null) {
  const called: string[] = []
  const callHost = (async (endpoint: Endpoint) => {
    called.push(endpoint.path)
    if (answer === null) return null
    return endpoint === routes.remoteAccess.status ? { ok: true, data: status } : answer
  }) as CallHost
  const lines: string[] = []
  const code = await runRemote(args, {
    callHost,
    hostRoot: '/nonexistent',
    env: {},
    prompt: async () => null,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    now: () => Date.parse(startedAt),
  })
  const text = lines.join('\n')
  for (const id of [alice, bob]) expect(text).not.toContain(id)
  return { code, text, called }
}

const ok = (data: SessionsResponse) => ({ ok: true as const, data })

describe('host:remote sessions', () => {
  test('prints one line per session with its credentials, or says none are open', async () => {
    const listed = await run(
      ['sessions'],
      ok({
        sessions: [
          {
            deviceId: alice,
            fingerprint: fingerprintOf(alice),
            credentials: [{ kind: 'account' }, { kind: 'key', name: 'laptop' }],
            sockets: 3,
            startedAt,
          },
          // A name that would move the cursor in a terminal.
          {
            deviceId: bob,
            fingerprint: fingerprintOf(bob),
            credentials: [{ kind: 'key', name: 'x\x1b' }],
            sockets: 1,
            startedAt,
          },
        ],
      }),
    )
    expect(listed.code).toBe(0)
    expect(listed.text.split('\n')).toEqual([
      `${fingerprintOf(alice)}  account, key laptop  3 sockets  since ${formatLocalDateTime(startedAt)}`,
      `${fingerprintOf(bob)}  key x?  1 socket  since ${formatLocalDateTime(startedAt)}`,
    ])
    expect(listed.called).toEqual([routes.remoteAccess.status.path, routes.remoteAccess.sessions.path])

    expect(await run(['sessions'], ok({ sessions: [] }))).toMatchObject({
      code: 0,
      text: 'No remote sessions are open',
    })
  })

  test('a stopped host has none, a refusal exits 1, and extra words print the usage', async () => {
    expect(await run(['sessions'], null)).toMatchObject({
      code: 0,
      text: 'No host is running, so no remote sessions are open',
    })
    expect(await run(['sessions'], { ok: false, status: 403, message: 'forbidden' })).toMatchObject({
      code: 1,
      text: 'forbidden',
    })
    const extra = await run(['sessions', 'end'], ok({ sessions: [] }))
    expect(extra).toMatchObject({ code: 1, called: [] })
    expect(extra.text).toContain('sessions                              List the approved devices')
  })
})
