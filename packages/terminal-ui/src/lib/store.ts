import {
  type Action,
  type AppState,
  buildSocketUrl,
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

export type Overlay = 'help' | 'new-workspace' | 'palette' | 'themes' | null
export type Theme = 'light' | 'dark'

export interface Snapshot {
  status: 'connecting' | 'open' | 'closed'
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
let transport: HostTransport | null = null

/** The transport of the connected page. Requests made before `connect` fail. */
export function getTransport(): HostTransport {
  if (!transport) throw new Error('Not connected to a host')
  return transport
}

function send(event: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
}

function handle(event: ServerEvent) {
  switch (event.type) {
    case 'hello':
      set({
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

/**
 * Keeps the events socket open through `via`, reconnecting a second after it drops.
 * Returns a cleanup that closes the socket and stops reconnecting.
 */
export function connect(via: HostTransport): () => void {
  transport = via
  // A new connection may be to another host, so drop what the last one said.
  set({ state: null, sessions: {}, info: null })
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    set({ status: 'connecting' })
    const ws = via.openSocket(buildSocketUrl(routes.sockets.events, {}))
    socket = ws
    ws.onopen = () => set({ status: 'open' })
    ws.onmessage = (message) => handle(JSON.parse(message.data) as ServerEvent)
    ws.onclose = () => {
      if (socket === ws) socket = null
      if (stopped) return
      set({ status: 'closed' })
      retry = setTimeout(open, 1000)
    }
  }
  open()

  return () => {
    stopped = true
    clearTimeout(retry)
    socket?.close()
    socket = null
    if (transport === via) transport = null
  }
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
