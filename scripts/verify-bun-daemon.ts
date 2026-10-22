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

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  rmSync(runtime, { recursive: true, force: true })
  process.exit(1)
}

/** A decoded frame return so callers can read control and output without casts at every site. */
type AnyFrame = DaemonFrame

class Client {
  private readonly decoder = new DaemonDecoder(DAEMON_PROTOCOL)
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
    this.socket.write(encodeControlFrame(message, DAEMON_PROTOCOL))
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

const child = Bun.spawn(
  [
    process.execPath,
    daemonScript,
    '--socket',
    socketPath,
    '--id',
    id,
    '--cols',
    '100',
    '--rows',
    '30',
    '--cwd',
    runtime,
    '--shell',
    shell,
  ],
  { env: { ...process.env, ORCH_PTY_TOKEN: token }, stdio: ['ignore', 'inherit', 'inherit'] },
)

async function hello(client: Client) {
  client.send({ type: 'hello', protocol: DAEMON_PROTOCOL, id, token })
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

  // 1. A first host attaches and sees a screen.
  const first = await Client.connect()
  const snapshot = await hello(first)
  if (!(snapshot.value as { status?: { id?: string } }).status?.id) fail('snapshot carried no identity')

  // 2. Output streams back as binary frames, not base64 JSON.
  first.send({ type: 'input', data: "printf 'BUN_DAEMON_OK\\n'\r" })
  await first.wait(outputHas('BUN_DAEMON_OK'))

  // 3. The shell keeps running while the host is gone, then a new connection finds it.
  first.send({ type: 'input', data: 'SURVIVAL=kept\r' })
  await Bun.sleep(200)
  first.close()

  const second = await Client.connect()
  await hello(second)
  second.send({ type: 'input', data: 'printf \'VAR=%s\\n\' "$SURVIVAL"\r' })
  await second.wait(outputHas('VAR=kept'))

  // 4. A resize is acknowledged with a new status carrying the new size.
  second.send({ type: 'resize', cols: 120, rows: 40 })
  const status = await second.wait((frame) => {
    if (frame.kind !== 'control') return false
    const value = frame.value as { type?: string; status?: { cols?: number; rows?: number } }
    return value.type === 'status' && value.status?.cols === 120 && value.status?.rows === 40
  })
  const size = (status.value as { status?: { cols?: number; rows?: number } }).status
  if (size?.cols !== 120 || size.rows !== 40) fail(`resize not applied: ${JSON.stringify(size)}`)

  // 5. Close ends the shell and the daemon says so.
  second.send({ type: 'close' })
  await second.wait((frame) => frame.kind === 'control' && (frame.value as { type?: string }).type === 'closed')
  const exited = await child.exited
  if (exited !== 0) fail(`daemon exited with code ${exited}`)

  console.log('PASS: Bun daemon handshake, binary output, reconnect persistence, resize and close')
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  rmSync(runtime, { recursive: true, force: true })
}
