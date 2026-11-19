import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ClientEvent,
  type LayoutNode,
  listPanes,
  makePane,
  makeSurface,
  makeWorkspace,
  newId,
  routes,
  type ServerEvent,
  type SessionInfo,
} from '@orch/shared'
import { AGENT_ICONS, Toaster } from '@orch/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect, getSnapshot, useApp } from '../lib/store'
import type { HostTransport } from '../transport'
import { TransportProvider } from '../transportContext'
import { LayoutView, tidyTitle } from './LayoutView'

let disconnect = () => {}
afterEach(() => disconnect())

/**
 * Connects the store through a fake transport and says `hello` with one pane holding a terminal, whose shell reports
 * a folder and agent tracking, and a `pulls` tab. Each entry of `sessions` adds another terminal tab before `pulls`,
 * with those fields over the first one's. With `split`, a second pane holding an `issues` tab sits to its right.
 * Returns what the page sent on the events socket, and `update` to report a session again.
 */
function setup({ split = false, sessions = [] as Partial<SessionInfo>[] } = {}) {
  const terminal = makeSurface('terminal')
  const others = sessions.map(() => makeSurface('terminal'))
  const pulls = makeSurface('pulls')
  const first = makePane([terminal, ...others, pulls])
  const root: LayoutNode = split
    ? {
        type: 'split',
        id: newId('split'),
        direction: 'row',
        ratio: 0.5,
        a: first,
        b: makePane([makeSurface('issues')]),
      }
    : first
  const workspace = makeWorkspace('main', '/home/me/repo', root)
  const session: SessionInfo = {
    id: terminal.id,
    title: 'me@box:/home/me/repo/src',
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

  const sent: ClientEvent[] = []
  let events: WebSocket | undefined
  const transport: HostTransport = {
    request: async () => Response.json({}),
    // Terminal views open sockets of their own; only the events socket records what it is sent.
    openSocket: (path) => {
      const isEvents = path.startsWith(routes.sockets.events.path)
      const socket = {
        readyState: 1,
        send: (data: string) => isEvents && sent.push(JSON.parse(data)),
        close: () => {},
      } as unknown as WebSocket
      if (isEvents) events = socket
      return socket
    },
  }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: [session, ...sessions.map((fields, i) => ({ ...session, ...fields, id: others[i].id }))],
    info: { home: '/home/me', shell: 'zsh', platform: 'darwin', projectRoot: '/home/me/repo' },
  }
  events?.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)

  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider value={transport}>
        <StoreLayout />
      </TransportProvider>
      <Toaster />
    </QueryClientProvider>,
  )
  const update = (session: SessionInfo) =>
    act(() => events?.onmessage?.({ data: JSON.stringify({ type: 'session', session }) } as MessageEvent))
  return { sent, terminal, session, update }
}

/** The layout of the store's first workspace, as a page shows it. */
function StoreLayout() {
  const workspace = useApp((s) => s.state?.workspaces[0])
  return workspace ? <LayoutView workspace={workspace} /> : null
}

const surfaces = () => listPanes(getSnapshot().state?.workspaces[0].root ?? makePane()).flatMap((p) => p.surfaces)

describe('LayoutView tab bar', () => {
  test('"New terminal" adds a terminal to the pane in one click', async () => {
    const user = userEvent.setup()
    setup()
    expect(screen.queryAllByRole('button', { name: 'Close Terminal' })).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'New terminal' }))

    expect(screen.getAllByRole('button', { name: 'Close Terminal' })).toHaveLength(1)
    expect(surfaces().map((s) => s.kind)).toEqual(['terminal', 'pulls', 'terminal'])
  })

  test("a terminal tab's menu copies its folder and stops tracking; other tabs keep the browser's menu", async () => {
    const user = userEvent.setup()
    const { sent, terminal } = setup()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('src') })
    expect(await screen.findByRole('menu', { name: 'src tab' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Copy working folder' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Copied ~/repo/src')
    expect(await navigator.clipboard.readText()).toBe('/home/me/repo/src')

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('src') })
    expect(await screen.findByRole('menu', { name: 'src tab' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Stop tracking the agent' }))
    expect(sent).toContainEqual({ type: 'agentTracking', sessionId: terminal.id, on: false })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const prevented: boolean[] = []
    const record = (event: Event) => prevented.push(event.defaultPrevented)
    document.addEventListener('contextmenu', record)
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('Pull requests') })
    document.removeEventListener('contextmenu', record)
    expect(prevented).toEqual([false])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

const claude = { kind: 'claude', sessionId: null, cwd: '/home/me/repo' } as const
const codex = { ...claude, kind: 'codex' } as const
const state = (name: 'working' | 'waiting' | 'idle') =>
  ({ state: name, reason: 'tool', source: 'hooks', since: 1 }) as const

/** The tab whose tooltip starts with this title. */
const tabOf = (title: string) => screen.getByTitle(new RegExp(`^${title}( |$)`))
/** A tab's leading icon slot, its first child. */
const leadingOf = (tab: HTMLElement) => tab.firstElementChild as HTMLElement
const statusSlotOf = (tab: HTMLElement) => tab.querySelector('[data-slot="status"]')

/** Waits until every terminal tab's view has loaded, which updates it outside of any user action. */
const terminalsLoaded = (count: number) =>
  waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Terminal input' })).toHaveLength(count))

/** Fails unless each element comes after the one before it in the page. */
function expectInOrder(...elements: (Element | null)[]) {
  for (let i = 1; i < elements.length; i++) {
    const before = elements[i - 1] as Element
    expect(before.compareDocumentPosition(elements[i] as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
}

describe('LayoutView agent tabs', () => {
  test("two agents' tabs show different identity icons and the same working mark, after the title", async () => {
    setup({
      sessions: [
        { title: 'Fix login', agent: claude, agentState: state('working') },
        { title: 'Add tests', agent: codex, agentState: state('working') },
      ],
    })
    await terminalsLoaded(3)
    const claudeTab = tabOf('Fix login')
    const codexTab = tabOf('Add tests')

    expect(leadingOf(claudeTab)).toHaveTextContent(AGENT_ICONS.claude.label)
    expect(leadingOf(codexTab)).toHaveTextContent(AGENT_ICONS.codex.label)
    expect(AGENT_ICONS.claude.label).not.toBe(AGENT_ICONS.codex.label)
    expect(leadingOf(claudeTab).children).toHaveLength(1)

    const claudeMark = within(claudeTab).getByRole('img', { name: 'Claude Code working' })
    const codexMark = within(codexTab).getByRole('img', { name: 'Codex working' })
    expect(claudeMark.innerHTML).toBe(codexMark.innerHTML)
    expect(claudeMark).toHaveClass('animate-spin')
    expect(codexMark).toHaveClass('animate-spin')
    expect(statusSlotOf(claudeTab)).toContainElement(claudeMark)
    expect(leadingOf(claudeTab)).not.toContainElement(claudeMark)
    expectInOrder(
      within(claudeTab).getByText('Fix login'),
      claudeMark,
      within(claudeTab).getByRole('button', { name: 'Close Fix login' }),
    )
  })

  test('an agent tab keeps its icon and its status slot through every state, and names the agent with none', async () => {
    const { session, update } = setup({ sessions: [{ title: 'Fix login', agent: claude }] })
    await terminalsLoaded(2)
    const tab = tabOf('Fix login')
    expect(tab).toHaveAttribute('title', 'Fix login\nClaude Code')
    const icon = leadingOf(tab).firstElementChild
    const slot = statusSlotOf(tab)
    expect(slot).toBeEmptyDOMElement()
    expect(slot).toHaveClass('w-[13px]', 'shrink-0')
    expect(within(tab).getByText('Fix login')).toHaveClass('min-w-0', 'flex-1', 'truncate')

    const id = (tab.closest('[data-tab-id]') as HTMLElement).dataset.tabId as string
    for (const [name, label] of [
      ['working', 'Claude Code working'],
      ['waiting', 'Claude Code waiting for you'],
      ['idle', 'Claude Code idle'],
    ] as const) {
      update({ ...session, id, title: 'Fix login', agent: claude, agentState: state(name) })
      expect(statusSlotOf(tab)).toBe(slot)
      expect(slot).toHaveClass('w-[13px]', 'shrink-0')
      expect(slot).toContainElement(within(tab).getByRole('img', { name: label }))
      expect(leadingOf(tab).firstElementChild).toBe(icon)
    }
  })

  test("a plain terminal's tab shows the terminal icon, or its state there, and no status slot", async () => {
    const { session, update } = setup()
    await terminalsLoaded(1)
    const tab = tabOf('src')
    expect(leadingOf(tab).firstElementChild).toHaveClass('lucide-square-terminal')
    expect(statusSlotOf(tab)).toBeNull()

    update({ ...session, progress: 'busy' })
    expect(leadingOf(tab)).toContainElement(within(tab).getByRole('img', { name: 'Working' }))
    expect(statusSlotOf(tab)).toBeNull()
  })
})

/** The pane holding the tab with this title. */
const paneOf = (tabTitle: string) => screen.getByTitle(tabTitle).closest('[data-pane-id]') as HTMLElement
const framedPanes = () => [...document.querySelectorAll('[data-pane-id][data-focus-frame]')]

describe('LayoutView focus frame', () => {
  test('in a split workspace only the focused pane is framed, and the frame follows focus', async () => {
    const user = userEvent.setup()
    setup({ split: true })
    const first = paneOf('Pull requests')
    const second = paneOf('Issues')
    expect(framedPanes()).toEqual([first])

    await user.click(screen.getByTitle('Issues'))

    expect(framedPanes()).toEqual([second])
  })

  test('a full-screen pane drops the frame, and leaving full screen puts it back', async () => {
    const user = userEvent.setup()
    setup({ split: true })
    const first = paneOf('Pull requests')

    await user.click(within(first).getByRole('button', { name: 'Full screen' }))
    expect(within(first).getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument()
    expect(framedPanes()).toEqual([])

    await user.click(within(first).getByRole('button', { name: 'Exit full screen' }))
    expect(framedPanes()).toEqual([first])
  })

  test('closing the other pane leaves a lone pane with no frame', async () => {
    const user = userEvent.setup()
    setup({ split: true })

    await user.click(screen.getByRole('button', { name: 'Close Issues' }))

    expect(screen.queryByTitle('Issues')).not.toBeInTheDocument()
    expect(paneOf('Pull requests')).toBeInTheDocument()
    expect(framedPanes()).toEqual([])
  })
})

describe('tidyTitle', () => {
  test.each([
    ['⠋ Fix login', 'Fix login'],
    ['✳ Fix login ●', 'Fix login'],
    ['  ◐  Fix login ⏺ ', 'Fix login'],
    ['repo · main', 'repo · main'],
    ['⠋', 'Terminal'],
    ['✳ ●', 'Terminal'],
    ['', 'Terminal'],
    ['\u2800 notes', '\u2800 notes'],
    ['me@box:/a/b/repo', 'repo'],
    ['⠋ me@box:/a/b/repo', 'repo'],
  ])('shows %j as %j', (title, shown) => {
    expect(tidyTitle(title)).toBe(shown)
  })

  test('takes a long run of glyphs in linear time', () => {
    const inside = `a${'●'.repeat(5000)}b`
    const started = performance.now()
    expect(tidyTitle(inside)).toBe(inside)
    expect(tidyTitle('⠋●✳'.repeat(5000))).toBe('Terminal')
    expect(tidyTitle(`${'●'.repeat(5000)}me@box:/a/b/repo${' ⠋'.repeat(5000)}`)).toBe('repo')
    expect(performance.now() - started).toBeLessThan(100)
  })
})
