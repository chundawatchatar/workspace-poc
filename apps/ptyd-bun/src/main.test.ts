import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { DAEMON_PROTOCOL, DaemonDecoder, type daemonStatus, deriveAgentState, encodeControlFrame } from '@orch/terminal'
import type { z } from 'zod'

// A real daemon with a fake shell that runs each line it is sent, as a program in the terminal would.

const SHELL = `#!/bin/sh
echo READY
while IFS= read -r line; do eval "$line"; done
`
const running: { daemon: Bun.Subprocess; dir: string }[] = []

afterEach(() => {
  for (const { daemon, dir } of running.splice(0)) {
    daemon.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let tries = 0; tries < 500; tries++) {
    const value = read()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Starts a daemon in a fresh short folder. `prepare` runs first, to set the folder up. */
async function daemon(prepare: (dir: string) => void = () => {}, shellName = 'shell.sh', script = SHELL) {
  // Not `tmpdir()`: on macOS its path can be too long for a Unix socket.
  const dir = mkdtempSync('/tmp/orch-main-')
  const shell = join(dir, shellName)
  writeFileSync(shell, script)
  chmodSync(shell, 0o700)
  prepare(dir)
  const socket = join(dir, 'host.sock')
  const main = join(import.meta.dir, 'main.ts')
  const process = Bun.spawn([Bun.argv[0] ?? 'bun', main, '--socket', socket, '--shell', shell], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  running.push({ daemon: process, dir })
  await until(() => {
    try {
      return statSync(socket).isSocket()
    } catch {
      return false
    }
  }, 'the daemon socket')
  return { dir, socket, process }
}

/** One host connection to a session: its statuses and everything the shell printed. */
async function attach(path: string, id: string, reporting = true) {
  const connection: Socket = createConnection(path)
  const decoder = new DaemonDecoder()
  const statuses: z.infer<typeof daemonStatus>[] = []
  const raw: string[] = []
  const peer = { statuses, raw, output: '', send: (value: unknown) => connection.write(encodeControlFrame(value)) }
  connection.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind === 'output') peer.output += Buffer.from(frame.bytes).toString()
      else {
        raw.push(JSON.stringify(frame.value))
        const { status } = frame.value as { status?: z.infer<typeof daemonStatus> }
        if (status) statuses.push(status)
      }
    }
  })
  await new Promise((done) => connection.once('connect', done))
  peer.send({ type: 'hello', protocol: DAEMON_PROTOCOL, id, token: `token-${id}`, cwd: '/tmp', reporting })
  return peer
}

test("a program's OSC 7501 reaches the status in the standard status, and its support question is answered", async () => {
  const { socket } = await daemon()
  const peer = await attach(socket, 'a')
  await until(() => peer.output.includes('READY'), 'the shell')
  const write = (data: string) => peer.send({ type: 'input', data: `printf '\\033]7501;${data}\\007'\r` })
  write('state=blocked:app=claude-code:kind=permission')
  const waiting = await until(() => peer.statuses.find((status) => status.agentReport), 'the waiting status')
  expect(waiting.agentReport).toMatchObject({ state: 'waiting', reason: 'permission' })
  const agent = { kind: 'claude', sessionId: null, cwd: '/tmp' } as const
  expect(
    deriveAgentState({ agent, alive: true, interrupted: null, agentReport: waiting.agentReport }, null, 1),
  ).toEqual({ state: 'waiting', reason: 'permission', since: 1 })

  write('state=done')
  await until(() => peer.statuses.at(-1)?.agentReport?.reason === 'finished', 'the finished status')
  expect(peer.statuses.at(-1)?.attention?.message).toBe('Finished')
  peer.send({ type: 'agentExited' })
  await until(() => peer.statuses.at(-1)?.agentReport === null, 'the status to go')

  // The daemon answers the support question itself, though a view is attached and answers every other query.
  peer.send({ type: 'viewing', on: true })
  peer.send({
    type: 'input',
    data: `stty raw -echo; printf '\\033]7501;?\\033\\\\'; r=$(dd bs=32 count=1 2>/dev/null); stty sane; echo "A$(printf %s "$r" | od -An -c | tr -d ' \\n')"\r`,
  })
  await until(() => peer.output.includes('A033]7501;?'), 'the answer')
}, 30_000)

test('with the switch off a report is kept but raises no notification', async () => {
  const { socket } = await daemon()
  const peer = await attach(socket, 'a', false)
  await until(() => peer.output.includes('READY'), 'the shell')
  peer.send({ type: 'input', data: "printf '\\033]7501;state=working\\007\\033]7501;state=done\\007'\r" })
  await until(() => peer.statuses.at(-1)?.agentReport?.reason === 'finished', 'the finished status')
  expect(peer.statuses.at(-1)?.attention).toBeNull()
  peer.send({ type: 'reporting', on: true })
  peer.send({ type: 'input', data: "printf '\\033]7501;state=working\\007\\033]7501;state=done\\007'\r" })
  await until(() => peer.statuses.at(-1)?.attention?.message === 'Finished', 'the notification')
}, 30_000)

test('a hello of another protocol is refused and closed, and live sessions keep running', async () => {
  const { socket } = await daemon()
  const live = await attach(socket, 'a')
  const before = await until(() => live.statuses.at(-1)?.pid, 'the live shell')

  const connection: Socket = createConnection(socket)
  const decoder = new DaemonDecoder()
  const received: unknown[] = []
  connection.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) received.push(frame.kind === 'control' ? frame.value : frame.kind)
  })
  const closed = new Promise((done) => connection.once('close', done))
  await new Promise((done) => connection.once('connect', done))
  connection.write(encodeControlFrame({ type: 'hello', protocol: DAEMON_PROTOCOL + 1, id: 'a', token: 'token-a' }))
  await closed
  expect(received).toEqual([{ type: 'refused', protocol: DAEMON_PROTOCOL }])

  const again = await attach(socket, 'a')
  expect(await until(() => again.statuses.at(-1)?.pid, 'the shell again')).toBe(before)
  expect(live.statuses.at(-1)?.alive).toBe(true)
}, 30_000)
