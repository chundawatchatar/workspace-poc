import {
  type Action,
  type AppState,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  CLOSE_MACHINE_OFFLINE,
  type ClientEvent,
  type HostInfo,
  listPanes,
  reduce,
  routes,
  type ServerEvent,
  type SessionInfo,
  type Workspace,
} from '@orch/shared'
import {
  applyThemeToDocument,
  DEFAULT_THEME,
  MODE_KEY,
  type ThemeChoice,
  themeById,
  themeFor,
  themeKey,
} from '@orch/ui'
import { useSyncExternalStore } from 'react'
import type { HostTransport } from '../transport'

export type Overlay = 'help' | 'new-workspace' | 'palette' | 'themes' | 'remote-access' | null
export type Theme = 'light' | 'dark'

/**
 * The page's connection to the host, read from the events socket. `connecting` lasts until the first `hello`;
 * `offline` means the server is up but the machine is not; `denied` means the host rejected the access key.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'denied'

export interface Snapshot {
  status: ConnectionStatus
  /** The transport the store is connected through, set by `connect` and cleared only by its own cleanup. */
  transport: HostTransport | null
  /** The shared layout, owned by the host. */
  state: AppState | null
  sessions: Record<string, SessionInfo>
  info: HostInfo | null
  /** Focused pane per workspace. Local to this browser window. */
  focus: Record<string, string>
  /** Pane shown full screen per workspace, if any. Local to this browser window. */
  zoom: Record<string, string>
  /** True between the leader key and the key that follows it. */
  leader: boolean
  sidebar: boolean
  overlay: Overlay
  /** The mode the user picked, and the mode that resolves to right now. */
  themeChoice: ThemeChoice
  theme: Theme
  /** The theme in use, and the theme to use for each mode. */
  themeId: string
  preferred: Record<Theme, string>
}

const initial: Snapshot = {
  status: 'connecting',
  transport: null,
  state: null,
  sessions: {},
  info: null,
  focus: {},
  zoom: {},
  leader: false,
  sidebar: true,
  overlay: null,
  themeChoice: 'system',
  theme: 'dark',
  themeId: DEFAULT_THEME.dark,
  preferred: DEFAULT_THEME,
}

let snapshot = initial
const listeners = new Set<() => void>()

function set(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot() {
  return snapshot
}

/** Selectors must return a primitive or an object already held in the store. */
export function useApp<T>(selector: (snapshot: Snapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(snapshot),
    () => selector(initial),
  )
}

let socket: WebSocket | null = null

/** The transport of the connected page. Requests made before `connect` fail. */
export function getTransport(): HostTransport {
  if (!snapshot.transport) throw new Error('Not connected to a host')
  return snapshot.transport
}

function send(event: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
}

function handle(event: ServerEvent) {
  switch (event.type) {
    case 'hello':
      set({
        status: 'open',
        state: event.state,
        info: event.info,
        sessions: Object.fromEntries(event.sessions.map((s) => [s.id, s])),
      })
      break
    case 'state':
      set({ state: event.state })
      break
    case 'session':
      set({ sessions: { ...snapshot.sessions, [event.session.id]: event.session } })
      break
    case 'session.gone': {
      const { [event.id]: _gone, ...sessions } = snapshot.sessions
      set({ sessions })
      break
    }
  }
}

/** The timer `connect` schedules reopens with. Tests pass a fake one. */
export interface ConnectTimer {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimer: ConnectTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The wait before each reopen of the events socket, in milliseconds; later retries use the last one. */
export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 10_000]

/** Opens the events socket again at once on the current connection; null while not connected. */
let reopenNow: (() => void) | null = null

/**
 * Keeps the events socket open through `via`. After a drop it reopens with a
 * growing wait (`RETRY_DELAYS`), reset by each `hello`; after a rejected key it
 * stops until `reconnect` is called. Returns a cleanup that closes the socket
 * and stops reconnecting.
 */
export function connect(via: HostTransport, timer: ConnectTimer = realTimer): () => void {
  // A new connection may be to another host, so drop what the last one said.
  set({ status: 'connecting', transport: via, state: null, sessions: {}, info: null })
  let stopped = false
  let retry: unknown
  let attempt = 0
  let own: WebSocket | null = null

  const open = () => {
    retry = undefined
    const ws = via.openSocket(buildSocketUrl(routes.sockets.events, {}))
    own = ws
    socket = ws
    ws.onmessage = (message) => {
      if (stopped || own !== ws) return
      const event = JSON.parse(message.data) as ServerEvent
      if (event.type === 'hello') attempt = 0
      handle(event)
    }
    ws.onclose = (event) => {
      if (socket === ws) socket = null
      // A socket replaced by `reconnect` closes late; only the current one decides the status.
      if (stopped || own !== ws) return
      own = null
      if (event.code === CLOSE_ACCESS_DENIED) {
        // The same key can't succeed, and each try counts against the server's bad-key limit.
        set({ status: 'denied' })
        return
      }
      set({ status: event.code === CLOSE_MACHINE_OFFLINE ? 'offline' : 'reconnecting' })
      retry = timer.set(open, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
      attempt++
    }
  }

  const reopen = () => {
    if (stopped) return
    timer.clear(retry)
    attempt = 0
    const old = own
    own = null
    if (socket === old) socket = null
    old?.close()
    set({ status: 'connecting' })
    open()
  }
  reopenNow = reopen
  open()

  // A cleanup that runs after a newer `connect` only closes its own socket and leaves the newer transport in place.
  return () => {
    stopped = true
    timer.clear(retry)
    own?.close()
    if (socket === own) socket = null
    if (reopenNow === reopen) reopenNow = null
    if (snapshot.transport === via) set({ transport: null })
  }
}

/** Opens the events socket again at once, with the backoff reset, such as after a rejected key. */
export function reconnect() {
  reopenNow?.()
}

/** Sends the current layout to the host, which stores it and passes it to other windows. */
export function pushState() {
  if (snapshot.state) send({ type: 'state', state: snapshot.state })
}

/** Applies a change locally. Pass `sync: false` for in-progress drags and call `pushState` at the end. */
export function dispatch(action: Action, sync = true) {
  if (!snapshot.state) return
  const next = reduce(snapshot.state, action)
  if (next === snapshot.state) return
  set({ state: next })
  if (sync) pushState()
}

/** Applies a change computed from the current layout, for changes the shared reducer has no action for. */
export function mutate(update: (state: AppState) => AppState, sync = true) {
  if (!snapshot.state) return
  const next = update(snapshot.state)
  if (next === snapshot.state) return
  set({ state: next })
  if (sync) pushState()
}

export function ackSession(sessionId: string) {
  send({ type: 'ack', sessionId })
}

/** Starts an interrupted terminal again: its agent on the saved conversation, or a plain shell. */
export function restoreSession(sessionId: string, mode: 'agent' | 'shell') {
  send({ type: 'restore', sessionId, mode })
}

export function setFocus(workspaceId: string, paneId: string) {
  const zoomed = snapshot.zoom[workspaceId]
  // Moving to another pane leaves full screen, so that pane is not hidden behind it.
  const leavesZoom = zoomed !== undefined && zoomed !== paneId
  if (snapshot.focus[workspaceId] === paneId && !leavesZoom) return
  const patch: Partial<Snapshot> = { focus: { ...snapshot.focus, [workspaceId]: paneId } }
  if (leavesZoom) {
    const { [workspaceId]: _left, ...zoom } = snapshot.zoom
    patch.zoom = zoom
  }
  set(patch)
}

export function zoomedPaneId(workspace: Workspace, zoom: Record<string, string>): string | undefined {
  const wanted = zoom[workspace.id]
  return wanted && listPanes(workspace.root).some((p) => p.id === wanted) ? wanted : undefined
}

export function toggleZoom(workspaceId: string, paneId: string) {
  const { [workspaceId]: current, ...rest } = snapshot.zoom
  set({ zoom: current === paneId ? rest : { ...rest, [workspaceId]: paneId } })
}

export function focusedPaneId(workspace: Workspace, focus: Record<string, string>): string {
  const panes = listPanes(workspace.root)
  const wanted = focus[workspace.id]
  return panes.some((p) => p.id === wanted) ? wanted : panes[0].id
}

export function setLeader(leader: boolean) {
  if (snapshot.leader !== leader) set({ leader })
}

export function toggleSidebar() {
  set({ sidebar: !snapshot.sidebar })
}

export function setOverlay(overlay: Overlay) {
  set({ overlay })
}

function resolveMode(choice: ThemeChoice): Theme {
  if (choice !== 'system') return choice
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

let themeApplied = false
let themeFade: ReturnType<typeof setTimeout> | undefined

function applyTheme(themeChoice: ThemeChoice, preferred: Record<Theme, string>) {
  const theme = resolveMode(themeChoice)
  const definition = themeFor(theme, preferred[theme])
  // Fade colours on a change, but not on the first application at page load.
  if (themeApplied && definition.id !== snapshot.themeId) {
    document.documentElement.classList.add('theme-switching')
    clearTimeout(themeFade)
    themeFade = setTimeout(() => document.documentElement.classList.remove('theme-switching'), 280)
  }
  themeApplied = true
  applyThemeToDocument(definition)
  set({ themeChoice, theme, themeId: definition.id, preferred })
}

/** Reads the saved choices and follows the system setting while the mode is `system`. */
export function initTheme() {
  const saved = read(MODE_KEY)
  applyTheme(saved === 'light' || saved === 'dark' ? saved : 'system', {
    light: themeFor('light', read(themeKey('light'))).id,
    dark: themeFor('dark', read(themeKey('dark'))).id,
  })
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = () => snapshot.themeChoice === 'system' && applyTheme('system', snapshot.preferred)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** Light, dark, or whatever the system is using. */
export function setThemeChoice(choice: ThemeChoice) {
  save(MODE_KEY, choice)
  applyTheme(choice, snapshot.preferred)
}

export function toggleThemeMode() {
  setThemeChoice(snapshot.theme === 'dark' ? 'light' : 'dark')
}

/**
 * Picks a theme. It becomes the preferred theme for its mode, and the mode
 * switches to match if the theme is for the other one.
 */
export function selectTheme(id: string) {
  const definition = themeById(id)
  if (!definition) return
  const preferred = { ...snapshot.preferred, [definition.mode]: definition.id }
  save(themeKey(definition.mode), definition.id)
  const choice = definition.mode === snapshot.theme ? snapshot.themeChoice : definition.mode
  if (choice !== snapshot.themeChoice) save(MODE_KEY, choice)
  applyTheme(choice, preferred)
}
