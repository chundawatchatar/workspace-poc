import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type ConnectOutcomeKind, machineFingerprint } from '@orch/shared'
import { linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { ConnectError } from './modules/remote-access/remote-access.errors'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import { machineKeyFile } from './modules/tunnel/tunnel.repository'
import {
  dir,
  email,
  host,
  key,
  linked,
  machineKey,
  pressCtrlC,
  run,
  runningHost,
  stoppedHost,
  useRemoteCliHarness,
} from './remote-cli.testing'
import { CANCELLED, HOST_STOPPED, REMOVE_IN_CLIENT } from './remote-cli-connect'

useRemoteCliHarness()

describe('host:remote connect and disconnect with the host running', () => {
  test('connect shows the server, the email and the key ending, asks, and connects only on yes', async () => {
    const url = runningHost()
    const args = ['connect', '--email', email, '--key', key, '--server', 'wss://other.example.com']

    const no = await run(url, args, { answers: [''] })
    expect(no.code).toBe(1)
    expect(no.text.split('\n')).toEqual([
      'Server:      wss://other.example.com',
      'Warning:     this is not the default server. Connect only if you run it or trust who does.',
      `Email:       ${email}`,
      `Key ends in: ${key.slice(-4)}`,
      'Connect this machine to this account? [y/N] ',
      'Not connected',
    ])
    expect((await run(url, args, { answers: [null] })).code).toBe(1)
    expect(host.calls).toEqual([])

    const yes = await run(url, args, { answers: ['YES'] })
    expect(yes.code).toBe(0)
    const fingerprint = machineFingerprint(machineKey.machineId)
    expect(yes.text.split('\n').slice(-5)).toEqual([
      'Connect this machine to this account? [y/N] ',
      'Connecting...',
      `Please approve this connect request in the client and check that it shows machine ${fingerprint}`,
      'The request expires in 15:00. Waiting for the answer; press Ctrl-C to cancel.',
      'Connected to Ada (a***@example.com) through wss://other.example.com',
    ])
    // The email shows only in the line the owner checks.
    expect(yes.text.split(email)).toHaveLength(2)
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: 'wss://other.example.com' }]])

    // Connected now, so a second connect is refused before anything is sent.
    const again = await run(url, ['connect', `--email=${email}`, `--key=${key}`, '--yes'])
    expect(again).toMatchObject({ code: 1, text: expect.stringContaining('already connected to Ada') })
    expect(host.calls).toHaveLength(1)
  })

  test('connect uses the default without --server, or the address a variable sets, and --yes skips the question', async () => {
    const url = runningHost()
    const yes = await run(url, ['connect', '--yes', '--key', key, '--email', ` ${email} `])
    expect(yes.code).toBe(0)
    expect(yes.text).not.toContain('[y/N]')
    expect(yes.text).not.toContain('Warning:')
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: DEFAULT_SERVER_URL }]])

    host.calls = []
    host.current = {
      ...host.current,
      linkedAccount: null,
      serverUrl: 'ws://127.0.0.1:4600',
      serverUrlSetBy: 'SERVER_URL',
    }
    const other = await run(url, ['connect', '--email', email, '--key', key, '--server', 'wss://other.example.com'])
    expect(other).toEqual({
      code: 1,
      text: 'SERVER_URL sets the server address to ws://127.0.0.1:4600. Leave out --server',
    })
    expect((await run(url, ['connect', '--email', email, '--key', key, '--yes'])).code).toBe(0)
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: 'ws://127.0.0.1:4600' }]])

    // A host refusal is printed as it is, and a name from the server can't fake a line.
    host.current = { ...host.current, linkedAccount: null }
    host.connectError = new ConnectError(400, "This key is unknown, used or expired, or the email doesn't match")
    const refused = await run(url, ['connect', '--email', email, '--key', key, '--yes'])
    expect(refused).toMatchObject({ code: 1, text: expect.stringContaining('This key is unknown') })
  })

  test('connect --yes still waits, and exits 1 with the message on a reject, a cancel in the dialog, expiry, a dropped tunnel or the host stopping', async () => {
    const url = runningHost()
    const args = ['connect', '--email', email, '--key', key, '--yes']
    const endings: [ConnectOutcomeKind, string][] = [
      ['rejected', 'The connect request was rejected in the client. Nothing was linked'],
      ['cancelled', 'The connect request was cancelled. Nothing was linked'],
      ['expired', 'The key expired before the connect request was accepted. Nothing was linked'],
      ['failed', 'The connection to the server ended before the connect request was answered. Nothing was linked'],
    ]
    for (const [kind, message] of endings) {
      host.current = { ...host.current, tunnel: 'off', linkedAccount: null, connectRequest: null }
      let reads = 0
      // The request ends at the second status read, so the CLI waits through one.
      host.owner = (h) => {
        if (++reads === 2) h.end(kind, message)
      }
      const { code, text } = await run(url, args)
      expect([kind, code]).toEqual([kind, 1])
      expect(text).not.toContain('[y/N]')
      expect(text).toContain('Please approve this connect request in the client')
      expect(text.split('\n').at(-1)).toBe(message)
      expect(reads).toBe(2)
    }

    host.current = { ...host.current, tunnel: 'off', connectRequest: null }
    let gone = false
    host.owner = () => {
      gone = true
    }
    const stopped = await run(url, args, { hostGone: () => gone })
    expect(stopped.code).toBe(1)
    expect(stopped.text).toEndWith(HOST_STOPPED)
    expect(host.calls.filter(([name]) => name === 'cancelConnect')).toEqual([])
  })

  test('Ctrl-C while the request waits, or while the Connect call is on its way, cancels it and exits 1', async () => {
    const url = runningHost()
    const args = ['connect', '--email', email, '--key', key, '--yes']
    host.owner = () => pressCtrlC()
    const waiting = await run(url, args)
    expect(waiting.code).toBe(1)
    expect(waiting.text).toEndWith(CANCELLED)
    expect(host.calls.map(([name]) => name)).toEqual(['connect', 'cancelConnect'])
    expect(host.current).toMatchObject({ linkedAccount: null, connectOutcome: { kind: 'cancelled' } })

    host.calls = []
    host.current = { ...host.current, tunnel: 'off', connectOutcome: null }
    host.onConnect = async () => {
      pressCtrlC()
      while (!host.calls.some(([name]) => name === 'cancelConnect')) await Bun.sleep(1)
    }
    const onItsWay = await run(url, args)
    expect(onItsWay.code).toBe(1)
    expect(onItsWay.text).toEndWith(CANCELLED)
    expect(onItsWay.text).not.toContain('Please approve')
    expect(host.calls.map(([name]) => name)).toEqual(['connect', 'cancelConnect'])
  })

  test('a malformed key, email or server, and the old commands, are refused before the host is called', async () => {
    const url = runningHost()
    const secret = 'oek_secret'
    const cases: [string[], string][] = [
      [['connect', '--email', email, '--key', secret], 'That is not an enrollment key.'],
      [['connect', '--email', 'secret@', '--key', key], 'That is not an email address'],
      [['connect', '--email', email, '--key', key, '--server', 'ws://secret.example.com'], 'The server address must'],
    ]
    for (const [args, message] of cases) {
      const { code, text } = await run(url, args)
      expect([code, text.startsWith(message)]).toEqual([1, true])
      for (const value of [secret, 'secret@', 'secret.example.com', email]) expect(text).not.toContain(value)
    }
    for (const args of [['link', key], ['unlink'], ['server', 'wss://x'], ['on'], ['off'], ['connect', '--key', key]]) {
      const { code, text } = await run(url, args)
      expect([args, code, text.startsWith('Usage:')]).toEqual([args, 1, true])
    }
    expect(host.statusCalls).toBe(0)
  })

  test("disconnect asks, and says when the machine is still on the account's list", async () => {
    const url = runningHost()
    expect((await run(url, ['disconnect'])).text).toBe('This machine is not connected')
    host.current = { ...host.current, tunnel: 'connected', linkedAccount: linked }

    const no = await run(url, ['disconnect'], { answers: ['n'] })
    expect(no.code).toBe(1)
    expect(no.text).toContain('Disconnect this machine from Ada (a***@example.com)? [y/N]')
    expect(host.calls).toEqual([])
    const yes = await run(url, ['disconnect'], { answers: ['y'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain('Disconnected.')
    expect(yes.text).not.toContain(REMOVE_IN_CLIENT)

    host.current = { ...host.current, linkedAccount: linked }
    host.removed = false
    const kept = await run(url, ['disconnect', '--yes'])
    expect(kept.code).toBe(0)
    expect(kept.text).not.toContain('[y/N]')
    expect(kept.text).toContain(REMOVE_IN_CLIENT)
    expect(host.calls).toEqual([
      ['disconnect', {}],
      ['disconnect', {}],
    ])
  })
})

describe('host:remote connect and disconnect with the host stopped', () => {
  test('connect and disconnect need the running host, and write nothing', async () => {
    const url = stoppedHost()
    writeFileSync(linkedAccountPath(dir), JSON.stringify(linked))
    for (const args of [
      ['connect', '--email', email, '--key', key, '--yes'],
      ['disconnect', '--yes'],
    ]) {
      expect(await run(url, args)).toEqual({ code: 1, text: 'No host is running. Start it, then run this again' })
    }
    expect(existsSync(machineKeyFile(dir))).toBe(false)
    expect(readFileSync(linkedAccountPath(dir), 'utf8')).toBe(JSON.stringify(linked))
  })
})
