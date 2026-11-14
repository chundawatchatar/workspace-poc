import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { repoRoot } from '@orch/shared/env'
import { DAEMON_PROTOCOL, DaemonDecoder, daemonBuild, daemonMessage, encodeControlFrame } from '@orch/terminal'
import { DAEMON_SUBCOMMAND, daemonCommand } from './modules/terminals/daemon-build'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function until(check: () => boolean, what: string) {
  for (let tries = 0; tries < 500 && !check(); tries++) await Bun.sleep(10)
  if (!check()) throw new Error(`timed out waiting for ${what}`)
}

test('the daemon subcommand runs the terminal daemon from the host entry point, with its shims and build', async () => {
  // Not `tmpdir()`: on macOS its path can be too long for a Unix socket.
  const dir = mkdtempSync('/tmp/orch-host-main-')
  const socket = join(dir, 'host.sock')
  const entry = join(repoRoot, 'apps', 'host', 'src', 'main.ts')
  const daemon = Bun.spawn([process.execPath, entry, DAEMON_SUBCOMMAND, '--socket', socket, '--shell', '/bin/sh'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  cleanups.push(() => {
    daemon.kill()
    rmSync(dir, { recursive: true, force: true })
  })
  const agent = join(dir, 'agent')
  const shims = [
    ...['orch-agent-hook', 'claude', 'codex'].map((name) => join(agent, 'bin', name)),
    ...['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((name) => join(agent, 'zsh', name)),
    join(agent, 'claude-settings.json'),
  ]
  await until(() => statSync(socket, { throwIfNoEntry: false })?.isSocket() === true, 'the daemon socket')
  await until(() => shims.every((file) => existsSync(file)), 'the shim files')

  const connection = createConnection(socket)
  cleanups.push(() => connection.destroy())
  const decoder = new DaemonDecoder()
  const first = new Promise<unknown>((done) =>
    connection.on('data', (chunk: Buffer) => {
      const control = decoder.push(chunk).find((frame) => frame.kind === 'control')
      if (control?.kind === 'control') done(control.value)
    }),
  )
  await new Promise((done) => connection.once('connect', done))
  connection.write(encodeControlFrame({ type: 'hello', protocol: DAEMON_PROTOCOL, id: 'a', token: 'token-a' }))
  const message = daemonMessage.parse(await first)
  if (message.type !== 'snapshot') throw new Error(`expected a snapshot, got ${message.type}`)
  expect(message.status.build).toBe(daemonBuild(join(repoRoot, 'apps', 'ptyd-bun', 'src')))
}, 30_000)

test('a packaged host runs itself with the daemon subcommand, and one run from source runs the dev command', () => {
  const dev = ['/usr/bin/bun', '/repo/apps/ptyd-bun/src/main.ts']
  expect(daemonCommand({ packaged: true, execPath: '/x/corch', dev })).toEqual(['/x/corch', '__daemon'])
  expect(daemonCommand({ packaged: false, execPath: '/x/corch', dev })).toBe(dev)
})
