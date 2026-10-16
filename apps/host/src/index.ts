import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { upgradeWebSocket, websocket } from '@hono/bun'
import {
  type AppState,
  type ClientEvent,
  type GitInfo,
  HOST_PORT,
  type HostInfo,
  listSurfaces,
  type ServerEvent,
  type TermClientMsg,
} from '@orch/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { SessionManager, type TermClient } from './sessions'
import { dataFile, StateStore } from './store'

const hostRoot = resolve(import.meta.dir, '..')
const projectRoot = resolve(hostRoot, '../..')
const store = new StateStore(dataFile(hostRoot), projectRoot)

const info: HostInfo = {
  home: homedir(),
  shell: process.env.SHELL || '/bin/zsh',
  platform: process.platform,
  projectRoot,
}

interface EventClient {
  id: string
  send(event: ServerEvent): void
}
const eventClients = new Set<EventClient>()

function broadcast(event: ServerEvent, except?: EventClient) {
  for (const client of eventClients) if (client !== except) client.send(event)
}

const sessions = new SessionManager(
  (session) => broadcast({ type: 'session', session: session.info() }),
  (id) => broadcast({ type: 'session.gone', id }),
)

function liveSessionIds(state: AppState) {
  return new Set(
    listSurfaces(state)
      .filter((s) => s.kind === 'terminal')
      .map((s) => s.id),
  )
}

// This server starts shells, so it only answers pages served from this machine.
function localOrigin(origin: string | null | undefined) {
  if (!origin) return true
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

function expandDir(path: string): string | null {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) return null
  try {
    return existsSync(expanded) && statSync(expanded).isDirectory() ? resolve(expanded) : null
  } catch {
    return null
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? out : null
}

const app = new Hono()

app.use('*', async (c, next) => {
  if (!localOrigin(c.req.header('origin'))) return c.text('forbidden', 403)
  await next()
})
app.use('/api/*', cors({ origin: (origin) => (localOrigin(origin) ? origin : null) }))

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/dir', (c) => {
  const path = expandDir(c.req.query('path') ?? '')
  return c.json({ path })
})

app.get('/api/git', async (c) => {
  const cwd = expandDir(c.req.query('cwd') ?? '')
  const empty: GitInfo = { branch: null, changes: 0 }
  if (!cwd) return c.json(empty)
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null
  if (!branch) return c.json(empty)
  const status = (await git(cwd, ['status', '--porcelain'])) ?? ''
  return c.json({ branch, changes: status.split('\n').filter(Boolean).length } satisfies GitInfo)
})

app.get(
  '/ws/events',
  upgradeWebSocket(() => {
    let client: EventClient | null = null
    return {
      onOpen(_event, ws) {
        client = { id: crypto.randomUUID(), send: (event) => ws.send(JSON.stringify(event)) }
        eventClients.add(client)
        client.send({
          type: 'hello',
          clientId: client.id,
          state: store.state,
          sessions: sessions.list().map((s) => s.info()),
          info,
        })
      },
      onMessage(event) {
        if (typeof event.data !== 'string' || !client) return
        const message = JSON.parse(event.data) as ClientEvent
        if (message.type === 'state') {
          store.set(message.state)
          broadcast({ type: 'state', state: store.state }, client)
          sessions.collect(liveSessionIds(store.state))
        } else if (message.type === 'ack') {
          sessions.get(message.sessionId)?.ack()
        }
      },
      onClose() {
        if (client) eventClients.delete(client)
      },
    }
  }),
)

app.get(
  '/ws/term/:id',
  upgradeWebSocket((c) => {
    const id = c.req.param('id') ?? ''
    const cwd = c.req.query('cwd') ?? ''
    const cols = Number(c.req.query('cols')) || 80
    const rows = Number(c.req.query('rows')) || 24
    let client: TermClient | null = null
    return {
      onOpen(_event, ws) {
        client = {
          ready: false,
          queue: [],
          want: null,
          send: (data) => ws.send(data as string | Uint8Array<ArrayBuffer>),
        }
        sessions.ensure(id, cwd, cols, rows).attach(client)
      },
      onMessage(event) {
        const session = sessions.get(id)
        if (typeof event.data !== 'string' || !session || !client) return
        const message = JSON.parse(event.data) as TermClientMsg
        if (message.type === 'input') session.input(message.data, client)
        else if (message.type === 'resize') session.resize(message.cols, message.rows, client)
        else if (message.type === 'focus') session.claim(client)
      },
      onClose() {
        if (client) sessions.get(id)?.detach(client)
      },
    }
  }),
)

const server = Bun.serve({ hostname: '127.0.0.1', port: HOST_PORT, fetch: app.fetch, websocket })
console.log(`host listening on http://${server.hostname}:${server.port}`)

function shutdown() {
  store.flush()
  sessions.killAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
