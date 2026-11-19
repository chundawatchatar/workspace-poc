import { afterEach, describe, expect, test } from 'bun:test'
import { makePane, makeSurface, makeWorkspace, type ServerEvent, type SessionInfo, type Workspace } from '@orch/shared'
import { AGENT_ICONS } from '@orch/ui'
import { render, screen, within } from '@testing-library/react'
import { connect, useApp } from '../lib/store'
import { NavigationProvider } from '../navigation'
import type { HostTransport } from '../transport'
import { formatElapsed, SidebarTerminals } from './SidebarTerminals'

let disconnect = () => {}
afterEach(() => disconnect())

const claude = { kind: 'claude', sessionId: null, cwd: '/home/me/repo' } as const
const started = { pid: 1, startedAt: Date.now() - 65_000 }

/**
 * Renders the terminal list of one workspace, with a terminal for each entry
 * of `sessions` (fields over a plain idle shell's). With `active`, the
 * workspace is the selected one.
 */
function setup(sessions: Partial<SessionInfo>[], { active = false } = {}) {
  const surfaces = sessions.map(() => makeSurface('terminal'))
  const workspace = makeWorkspace('main', '/home/me/repo', makePane(surfaces))
  const base: SessionInfo = {
    id: '',
    title: 'repo',
    alive: true,
    attention: null,
    process: null,
    cwd: '/home/me/repo/src',
    progress: null,
    agent: null,
    interrupted: null,
    agentState: null,
    agentTracking: true,
  }
  const socket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  const transport: HostTransport = { request: async () => Response.json({}), openSocket: () => socket }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: sessions.map((fields, i) => ({ ...base, ...fields, id: surfaces[i].id })),
    info: { home: '/home/me', shell: '/bin/zsh', platform: 'darwin', projectRoot: '/home/me/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)
  render(
    <NavigationProvider value={{ workspaceId: workspace.id, navigate: () => {}, workspaceHref: (id) => `/w/${id}` }}>
      <StoreTerminals workspace={workspace} active={active} />
    </NavigationProvider>,
  )
}

function StoreTerminals({ workspace, active }: { workspace: Workspace; active: boolean }) {
  useApp((s) => s.state)
  return <SidebarTerminals workspace={workspace} active={active} />
}

/** A row's leading icon slot, its first child. */
const leadingOf = (row: HTMLElement) => row.firstElementChild as HTMLElement
const statusSlotOf = (row: HTMLElement) => row.querySelector('[data-slot="status"]')
const signalIn = (element: Element | null, signal: string) => element?.querySelector(`[data-signal="${signal}"]`)

/** Fails unless each element comes after the one before it in the page. */
function expectInOrder(...elements: (Element | null | undefined)[]) {
  for (let i = 1; i < elements.length; i++) {
    const before = elements[i - 1] as Element
    expect(before.compareDocumentPosition(elements[i] as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
}

describe('SidebarTerminals', () => {
  test('an agent row reads identity icon, name, path, elapsed time, attention dot, then its status', () => {
    setup([
      {
        process: { ...started, name: 'claude', command: 'claude' },
        agent: claude,
        agentState: { state: 'idle', reason: 'finished', source: 'hooks', since: 1 },
        attention: { at: 10, message: 'Done' },
      },
      { process: { ...started, name: 'codex', command: 'codex' }, agent: { ...claude, kind: 'codex' } },
    ])
    const row = screen.getByRole('button', { name: /^claude/ })
    const slot = statusSlotOf(row)
    expect(leadingOf(row)).toHaveTextContent(AGENT_ICONS.claude.label)
    expect(slot).toContainElement(within(row).getByRole('img', { name: 'Claude Code idle' }))
    expectInOrder(
      leadingOf(row),
      within(row).getByText('claude'),
      within(row).getByText('~/repo/src'),
      within(row).getByText('1m'),
      signalIn(row, 'attention'),
      slot,
    )
    expect(signalIn(slot, 'attention')).toBeNull()

    const codex = screen.getByRole('button', { name: /^codex/ })
    expect(leadingOf(codex)).toHaveTextContent(AGENT_ICONS.codex.label)
    expect(signalIn(statusSlotOf(codex), 'running')).toBeInTheDocument()
    expect(signalIn(leadingOf(codex), 'running')).toBeNull()
  })

  test("a row with no agent keeps today's dot at its start and no status slot", () => {
    setup(
      [
        { process: { ...started, name: 'vim', command: 'vim' }, attention: { at: 10, message: 'Bell' } },
        { process: { ...started, name: 'make', command: 'make' } },
        { interrupted: { agent: claude, cwd: '/home/me/repo', command: 'claude --continue' } },
      ],
      { active: true },
    )
    const bell = screen.getByRole('button', { name: /^vim/ })
    const make = screen.getByRole('button', { name: /^make/ })
    const interrupted = screen.getByRole('button', { name: /^Claude Code · interrupted/ })
    expect(signalIn(leadingOf(bell), 'attention')).toBeInTheDocument()
    expect(signalIn(leadingOf(make), 'running')).toBeInTheDocument()
    expect(within(leadingOf(interrupted)).getByTitle('Interrupted')).toBeInTheDocument()
    for (const row of [bell, make, interrupted]) expect(statusSlotOf(row)).toBeNull()
  })
})

describe('formatElapsed', () => {
  test.each([
    [-1000, '0s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [3_600_000, '1h'],
    [3_900_000, '1h 5m'],
    [172_800_000, '2d'],
  ] as const)('%d ms reads %s', (ms, label) => {
    expect(formatElapsed(ms)).toBe(label)
  })
})
