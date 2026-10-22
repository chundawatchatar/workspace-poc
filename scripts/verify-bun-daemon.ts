import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DAEMON_PROTOCOL, DaemonDecoder, type DaemonFrame, encodeControlFrame } from '@orch/terminal'

/**
 * End-to-end check for the Bun terminal daemon, mirroring the Rust acceptance
 * script: it owns a real shell, keeps it across a client disconnect (the host
 * restart case), streams output as binary frames, and ends the shell on close.
 */

const root = resolve(import.meta.dir, '..')
const daemonScript = join(root, 'apps/ptyd-bun/src/main.ts')
const runtime = mkdtempSync(join(tmpdir(), 'orch-bun-verify-'))
const socketPath = join(runtime, 'term-verify.sock')
const id = 'term_verify'
const token = randomUUID()
const shell = process.env.SHELL || '/bin/sh'

let step = 'start'
let daemon: { kill(): void } | null = null

function fail(message: string): never {
  console.error(`FAIL at ${step}: ${message}`)
  // The daemon was started detached from this script's exit, so stop it here too.
  daemon?.kill()
  rmSync(runtime, { recursive: true, force: true })
  process.exit(1)
}

/** A decoded frame return so callers can read control and output without casts at every site. */
type AnyFrame = DaemonFrame

class Client {
  private readonly decoder = new DaemonDecoder()
  private readonly pending: AnyFrame[] = []
  private readonly waiters: {
    match: (frame: AnyFrame) => boolean
    resolve: (frame: AnyFrame) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []

  private constructor(private readonly socket: Socket) {}

  static connect(): Promise<Client> {
    return new Promise((done, reject) => {
      const socket = createConnection(socketPath)
      const client = new Client(socket)
      socket.on('connect', () => done(client))
      socket.on('error', reject)
      socket.on('data', (chunk: Buffer) => {
        for (const frame of client.decoder.push(chunk)) client.deliver(frame)
      })
    })
  }

  private deliver(frame: AnyFrame) {
    const index = this.waiters.findIndex((waiter) => waiter.match(frame))
    if (index === -1) {
      this.pending.push(frame)
      return
    }
    const [waiter] = this.waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.resolve(frame)
  }

  send(message: unknown) {
    this.socket.write(encodeControlFrame(message))
  }

  wait(match: (frame: AnyFrame) => boolean, timeout = 5000): Promise<AnyFrame> {
    const index = this.pending.findIndex(match)
    if (index !== -1) return Promise.resolve(this.pending.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.length = 0
        reject(new Error('timed out waiting for a daemon frame'))
      }, timeout)
      this.waiters.push({ match, resolve, timer })
    })
  }

  close() {
    this.socket.destroy()
  }
}

const isSnapshot = (frame: AnyFrame) =>
  frame.kind === 'control' && (frame.value as { type?: string }).type === 'snapshot'
const outputHas = (needle: string) => (frame: AnyFrame) => 'bytes' in frame && Buffer.from(frame.bytes).includes(needle)

const child = Bun.spawn([process.execPath, daemonScript, '--socket', socketPath, '--shell', shell], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
daemon = child

async function hello(client: Client) {
  client.send({ type: 'hello', protocol: DAEMON_PROTOCOL, id, token, cwd: runtime, cols: 100, rows: 30 })
  const snapshot = await client.wait(isSnapshot)
  if (!isSnapshot(snapshot)) fail('first frame was not a snapshot')
  return snapshot
}

/** Bun needs a moment to load the terminal libraries and bind the socket. */
async function waitForSocket() {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return
    await Bun.sleep(20)
  }
  fail('daemon socket did not appear')
}

try {
  await waitForSocket()

  step = '1'
  // 1. A first host attaches and sees a screen.
  const first = await Client.connect()
  const snapshot = await hello(first)
  const identity = (snapshot.value as { status?: { id?: string; build?: string; queries?: boolean } }).status
  if (!identity?.id) fail('snapshot carried no identity')
  if (!identity.build || !identity.queries) fail(`status lacks the build or query support: ${JSON.stringify(identity)}`)

  step = '2'
  // 2. Output streams back as binary frames, not base64 JSON.
  first.send({ type: 'input', data: "printf 'BUN_DAEMON_OK\\n'\r" })
  await first.wait(outputHas('BUN_DAEMON_OK'))

  step = '3'
  // 3. The shell keeps running while the host is gone, then a new connection finds it.
  first.send({ type: 'input', data: 'SURVIVAL=kept\r' })
  await Bun.sleep(200)
  first.close()

  const second = await Client.connect()
  await hello(second)
  second.send({ type: 'input', data: 'printf \'VAR=%s\\n\' "$SURVIVAL"\r' })
  await second.wait(outputHas('VAR=kept'))

  step = '4'
  // 4. A request from a newer host is ignored rather than ending the connection.
  second.send({ type: 'from-the-future' })
  second.send({ type: 'input', data: "printf 'STILL_%s\\n' CONNECTED\r" })
  await second.wait(outputHas('STILL_CONNECTED'))

  step = '5'
  // 5. With no view attached the daemon answers terminal queries; once one is, it leaves them to the view.
  const ask = (mark: string) =>
    second.send({
      type: 'input',
      data: `r=; printf '\\033[c'; IFS= read -rs -t 1 -d c r; echo "${mark}<\${r//[^0-9;?]/}>"\r`,
    })
  ask('DA')
  await second.wait(outputHas('DA<?1;2>'))
  second.send({ type: 'viewing', on: true })
  ask('NONE')
  await second.wait(outputHas('NONE<>'))

  step = '6'
  // 6. A redraw makes a full-screen program get SIGWINCH, so it repaints for a view that just attached.
  second.send({
    type: 'input',
    // A child shell, so the trap runs in the foreground process group that receives SIGWINCH.
    data: "printf '\\033[?1049h'; bash -c 'trap \"echo GOT_\"WINCH WINCH; while :; do sleep 0.05; done'\r",
  })
  await Bun.sleep(500)
  second.send({ type: 'redraw' })
  await second.wait(outputHas('GOT_WINCH'))
  second.send({ type: 'input', data: "\x03printf '\\033[?1049l'\r" })

  step = '7'
  // 7. A resize is acknowledged with a new status carrying the new size.
  second.send({ type: 'resize', cols: 120, rows: 40 })
  const status = await second.wait((frame) => {
    if (frame.kind !== 'control') return false
    const value = frame.value as { type?: string; status?: { cols?: number; rows?: number } }
    return value.type === 'status' && value.status?.cols === 120 && value.status?.rows === 40
  })
  const size = (status.value as { status?: { cols?: number; rows?: number } }).status
  if (size?.cols !== 120 || size.rows !== 40) fail(`resize not applied: ${JSON.stringify(size)}`)

  step = '8'
  // 8. Close ends the session but not the daemon; the daemon stops only when asked.
  second.send({ type: 'close' })
  await second.wait((frame) => frame.kind === 'control' && (frame.value as { type?: string }).type === 'closed')
  const stopper = await Client.connect()
  stopper.send({ type: 'stop' })
  const exited = await child.exited
  if (exited !== 0) fail(`daemon exited with code ${exited}`)

  console.log(
    'PASS: shared daemon handshake, binary output, reconnect persistence, unknown requests, query answering, ' +
      'redraw, resize, close and stop',
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  rmSync(runtime, { recursive: true, force: true })
}

// The client sockets may still be closing; exit without waiting on them.
process.exit(0)
