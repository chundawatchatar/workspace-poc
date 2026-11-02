import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { DAEMON_PROTOCOL, DaemonDecoder, type daemonStatus, deriveAgentState, encodeControlFrame } from '@orch/terminal'
import type { z } from 'zod'

// A real daemon with a fake shell that prints its reporting variables, then waits for a line and exits.

const SHELL = `#!/bin/sh
echo "TOKEN=[$ORCH_AGENT_TOKEN] SOCKET=[$ORCH_AGENT_SOCKET]"
read line
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

/** Waits for a file's mode. The daemon writes its shim just after binding, so the socket appearing doesn't mean it's there. */
async function untilMode(path: string, mode: number) {
  const current = () => statSync(path, { throwIfNoEntry: false })?.mode
  await until(() => ((current() ?? 0) & 0o777) === mode, `mode ${mode.toString(8)} on ${path}`)
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
async function attach(path: string, id: string, tracking?: { claude: boolean; codex: boolean }) {
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
  peer.send({ type: 'hello', protocol: DAEMON_PROTOCOL, id, token: `token-${id}`, cwd: '/tmp', tracking })
  return peer
}

/** The variables printed by the newest shell of a session, once `seen` shells have printed theirs. */
async function shellVariables(peer: { output: string }, seen = 1) {
  const lines = await until(() => {
    const found = [...peer.output.matchAll(/TOKEN=\[(.*?)\] SOCKET=\[(.*?)\]/g)]
    return found.length >= seen && found
  }, 'the shell output')
  const [, token, socket] = lines.at(-1) ?? []
  return { token: token ?? '', socket: socket ?? '' }
}

const request = (socket: string, token: string, path: string, body?: unknown) =>
  fetch(`http://agent${path}`, {
    unix: socket,
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })

test('a tracked shell can report over a private Unix socket, for as long as its token lives', async () => {
  const { dir, socket } = await daemon()
  const tracked = await attach(socket, 'a', { claude: true, codex: false })
  const first = await shellVariables(tracked)
  expect(first.token).toMatch(/^[a-f0-9]{64}$/)
  expect(first.socket).toBe(join(dir, 'agent.sock'))
  expect(statSync(first.socket).mode & 0o777).toBe(0o600)

  const other = await attach(socket, 'b', { claude: true, codex: true })
  const second = await shellVariables(other)
  expect(second.token).not.toBe(first.token)
  const plain = await attach(socket, 'c')
  expect(await shellVariables(plain)).toEqual({ token: '', socket: '' })
  const off = await attach(socket, 'd', { claude: false, codex: false })
  expect((await shellVariables(off)).token).toBe('')

  expect(await (await request(first.socket, first.token, '/v1/session')).json()).toEqual({ claude: true, codex: false })
  const event = { agent: 'claude', state: 'working', reason: 'tool' }
  expect((await request(first.socket, first.token, '/v1/state', event)).status).toBe(204)
  const reported = await until(() => tracked.statuses.find((status) => status.agentHook), 'the hook status')
  expect(reported.agentHook).toMatchObject(event)
  expect(other.statuses.every((status) => !status.agentHook)).toBe(true)

  tracked.send({ type: 'agentExited' })
  await until(() => tracked.statuses.at(-1)?.agentHook === null, 'the hook state to go')

  // The shell's `read` returns on Enter, so it exits; the next Enter starts a new one.
  tracked.send({ type: 'input', data: '\r' })
  await until(() => tracked.statuses.at(-1)?.alive === false, 'the shell to exit')
  expect((await request(first.socket, first.token, '/v1/session')).status).toBe(401)
  tracked.send({ type: 'input', data: '\r' })
  const restarted = await shellVariables(tracked, 2)
  expect(restarted.token).toMatch(/^[a-f0-9]{64}$/)
  expect(restarted.token).not.toBe(first.token)
  expect((await request(first.socket, restarted.token, '/v1/session')).status).toBe(200)

  tracked.send({ type: 'tracking', claude: false, codex: false })
  await Bun.sleep(50)
  expect((await request(first.socket, restarted.token, '/v1/session')).status).toBe(401)

  other.send({ type: 'close' })
  await Bun.sleep(50)
  expect((await request(first.socket, second.token, '/v1/session')).status).toBe(401)

  for (const message of [...tracked.raw, ...other.raw]) {
    for (const token of [first.token, second.token, restarted.token]) expect(message).not.toContain(token)
  }
}, 30_000)

test('a daemon that can not bind the channel logs it, issues no tokens and its terminals still work', async () => {
  // A folder in the socket's place can be neither unlinked nor bound.
  const { socket, process } = await daemon((dir) => mkdirSync(join(dir, 'agent.sock', 'taken'), { recursive: true }))
  const peer = await attach(socket, 'a', { claude: true, codex: true })
  expect(await shellVariables(peer)).toEqual({ token: '', socket: '' })
  expect(peer.statuses.at(-1)?.alive ?? true).toBe(true)
  process.kill()
  const log = await new Response(process.stderr as ReadableStream).text()
  expect(log).toContain('the agent channel is off')
}, 30_000)

test('a turn of generated hooks reaches the status, and a shell with tracking off gets nothing', async () => {
  // Named `zsh` for the wrapper. It runs each line the test sends, as a user's agent would run its hooks.
  const script = `#!/bin/sh
echo "PATH=[$PATH] ZDOTDIR=[$ZDOTDIR]"
${SHELL.split('\n')[1]}
while IFS= read -r line; do eval "$line"; done
`
  const { dir, socket } = await daemon(() => {}, 'zsh', script)
  const root = join(dir, 'agent')
  await untilMode(root, 0o700)
  await untilMode(join(root, 'bin', 'orch-agent-hook'), 0o700)
  await untilMode(join(root, 'claude-settings.json'), 0o600)

  const shellLine = (peer: { output: string }) => /PATH=\[(.*?)\] ZDOTDIR=\[(.*?)\]/.exec(peer.output)
  const off = await attach(socket, 'off', { claude: false, codex: false })
  const plain = await until(() => shellLine(off), 'the plain shell')
  expect(plain[1]).not.toContain(root)
  expect(plain[2]).toBe('')
  expect((await shellVariables(off)).token).toBe('')

  const tracked = await attach(socket, 'on', { claude: true, codex: false })
  const shellEnvironment = await until(() => shellLine(tracked), 'the tracked shell')
  expect(shellEnvironment[1]?.split(':')[0]).toBe(join(root, 'bin'))
  expect(shellEnvironment[2]).toBe(join(root, 'zsh'))

  const settings = JSON.parse(await Bun.file(join(root, 'claude-settings.json')).text())
  const command = (event: string, matcher?: string) =>
    (settings.hooks[event] as { matcher?: string; hooks: { command: string }[] }[]).find(
      (group) => group.matcher === matcher,
    )?.hooks[0]?.command
  const turn = [
    [command('SessionStart', 'startup|resume|clear'), 'idle', 'started'],
    [command('UserPromptSubmit'), 'working', 'prompt'],
    [command('Notification', 'permission_prompt'), 'waiting', 'permission'],
    [command('Stop'), 'idle', 'finished'],
  ] as const
  for (const [line, state, reason] of turn) {
    tracked.send({ type: 'input', data: `${line}\r` })
    await until(
      () => tracked.statuses.at(-1)?.agentHook?.reason === reason && tracked.statuses.at(-1),
      `the ${reason} status`,
    )
    expect(tracked.statuses.at(-1)?.agentHook).toMatchObject({ agent: 'claude', state, reason })
  }
  tracked.send({ type: 'input', data: `${command('SessionEnd')}\r` })
  await until(() => tracked.statuses.at(-1)?.agentHook === null, 'the hook state to go')
}, 30_000)

test('a Codex turn reaches the status through the hook, and the shim adds nothing where Codex is not tracked', async () => {
  // Named `zsh` for the wrapper. It runs each line the test sends, as a user's agent would run its hooks.
  const script = `#!/bin/sh
echo "PATH=[$PATH]"
${SHELL.split('\n')[1]}
while IFS= read -r line; do eval "$line"; done
`
  const { dir, socket } = await daemon(() => {}, 'zsh', script)
  const bin = join(dir, 'agent', 'bin')
  await untilMode(join(bin, 'codex'), 0o700)
  const ran = join(dir, 'ran')
  const mine = join(dir, 'my program')
  writeFileSync(mine, `#!/bin/sh\necho "$1|$2|$ORCH_AGENT_TOKEN" >"${ran}"\n`)
  chmodSync(mine, 0o700)

  const tracked = await attach(socket, 'on', { claude: false, codex: true })
  await shellVariables(tracked)
  const json = '{"type":"agent-turn-complete"}'
  tracked.send({ type: 'input', data: `${join(bin, 'orch-agent-hook')} codex '${mine}' turn-ended '${json}'\r` })
  const status = await until(() => tracked.statuses.find((each) => each.agentHook), 'the hook status')
  expect(status.agentHook).toMatchObject({ agent: 'codex', state: 'idle', reason: 'finished' })
  const output = await until(() => existsSync(ran) && readFileSync(ran, 'utf8'), 'the user program')
  expect(output).toBe(`turn-ended|${json}|\n`)
  const signals = { alive: true, interrupted: null, progress: null, attention: null, agentHook: status.agentHook }
  const agent = { kind: 'codex', sessionId: null, cwd: '/tmp' } as const
  expect(deriveAgentState({ ...signals, agent }, null, 1)).toMatchObject({
    state: 'idle',
    reason: 'finished',
    source: 'hooks',
  })

  // A fake `codex` straight after the shim shows what it passes on, and keeps any real Codex out of the test.
  const fakes = join(dir, 'fakes')
  mkdirSync(fakes)
  const seen = join(dir, 'seen')
  writeFileSync(join(fakes, 'codex'), `#!/bin/sh\necho "[$*]" >"${seen}"\n`)
  chmodSync(join(fakes, 'codex'), 0o700)
  const other = await attach(socket, 'other', { claude: true, codex: false })
  await shellVariables(other)
  other.send({ type: 'input', data: `export PATH="${bin}:${fakes}:/usr/bin:/bin" HOME="${dir}"; codex x\r` })
  // Not just `existsSync`: the shell creates the file before `echo` writes to it.
  const passed = await until(() => existsSync(seen) && readFileSync(seen, 'utf8'), 'the plain binary')
  expect(passed).toBe('[x]\n')
}, 30_000)

test('a daemon that can not write the shim folder still starts terminals that can report', async () => {
  // A file in the folder's place stops it from being created.
  const { dir, socket } = await daemon((dir) => writeFileSync(join(dir, 'agent'), ''))
  const peer = await attach(socket, 'a', { claude: true, codex: false })
  const { token } = await shellVariables(peer)
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect((await request(join(dir, 'agent.sock'), token, '/v1/session')).status).toBe(200)
}, 30_000)
