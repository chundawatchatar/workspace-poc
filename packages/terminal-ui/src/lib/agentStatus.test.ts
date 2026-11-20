import { describe, expect, test } from 'bun:test'
import {
  type AgentReason,
  type AgentState,
  type AgentStateName,
  makePane,
  makeSurface,
  makeWorkspace,
  type SessionInfo,
  type Surface,
} from '@orch/shared'
import {
  type AgentStatusKind,
  agentCounts,
  agentCountsLabel,
  agentStatus,
  type SidebarSignal,
  sidebarSignal,
  withStatus,
} from './agentStatus'

const claude = { kind: 'claude', sessionId: null, cwd: '/w' } as const
const codex = { kind: 'codex', sessionId: null, cwd: '/w' } as const

function agentState(state: AgentStateName, reason: AgentReason): AgentState {
  return { state, reason, since: 1 }
}

/** The fields of a live, tracked session. */
const live = { title: 'repo', alive: true, interrupted: null, agentTracking: true } as const

describe('agentStatus', () => {
  const kinds: [AgentState | null | undefined, SessionInfo['progress'], AgentStatusKind | undefined][] = [
    [agentState('working', 'turn'), 'error', 'working'],
    [agentState('waiting', 'permission'), 'busy', 'waiting'],
    [agentState('waiting', 'auth'), null, 'waiting'],
    [agentState('idle', 'finished'), 'error', 'idle'],
    [agentState('idle', 'ready'), null, 'idle'],
    // Failed is the agent's own word, not the progress bar's.
    [agentState('idle', 'error'), null, 'failed'],
    // An agent that reports nothing shows nothing, whatever its terminal shows.
    [null, 'busy', undefined],
    [undefined, 'error', undefined],
    [null, null, undefined],
  ]

  test.each(kinds)('picks the kind from state %j and progress %j', (state, progress, kind) => {
    expect(agentStatus({ ...live, agentState: state, progress, agent: claude })?.kind).toBe(kind)
  })

  test('shows nothing for a terminal with no session yet', () => {
    expect(agentStatus(undefined)).toBeNull()
  })

  test('shows the progress of a program with no agent, in plain labels', () => {
    expect(agentStatus({ ...live, progress: 'busy', agent: null })).toEqual({
      kind: 'working',
      label: 'Working',
      tooltip: 'Working',
    })
    expect(agentStatus({ ...live, progress: 'error', agent: null })?.label).toBe('Failed')
    expect(agentStatus({ ...live, progress: null, agent: null })).toBeNull()
  })

  test('names the agent, state and reason', () => {
    const status = (state: AgentState, agent: typeof claude | typeof codex = claude) =>
      agentStatus({ ...live, agentState: state, progress: null, agent })

    expect(status(agentState('waiting', 'permission'))?.tooltip).toBe('Claude Code waiting for you: needs permission')
    expect(status(agentState('working', 'turn'), codex)).toMatchObject({
      label: 'Codex working',
      tooltip: 'Codex working: running a turn',
    })
    expect(status(agentState('idle', 'finished'))).toMatchObject({
      label: 'Claude Code idle',
      tooltip: 'Claude Code idle: turn finished',
    })
  })
})

test('withStatus adds the status to the tooltip, and nothing without one', () => {
  const status = agentStatus({ ...live, progress: 'busy', agent: null })
  expect(withStatus('npm test', status)).toBe('npm test\nWorking')
  expect(withStatus('npm test', null)).toBe('npm test')
})

describe('sidebarSignal', () => {
  const session = { attention: null, interrupted: null, process: null, alive: true }
  const attention = { at: 1, message: 'Done' }
  const interrupted = { agent: claude, cwd: '/w', command: 'claude' }
  const process = { pid: 1, name: 'claude', command: 'claude', startedAt: 1 }
  const idle = agentStatus({ ...live, agentState: agentState('idle', 'finished'), progress: null, agent: claude })
  const waiting = agentStatus({ ...live, agentState: agentState('waiting', 'question'), progress: null, agent: claude })
  const working = agentStatus({ ...live, progress: 'busy', agent: null })
  const failed = agentStatus({ ...live, progress: 'error', agent: null })
  const silent = agentStatus({ ...live, agentState: null, progress: null, agent: claude })

  const rows: [string, Parameters<typeof sidebarSignal>[0], Parameters<typeof sidebarSignal>[1], SidebarSignal][] = [
    ['working beats attention', { ...session, attention }, working, 'status'],
    ['waiting beats attention', { ...session, attention }, waiting, 'status'],
    ['failed beats attention', { ...session, attention }, failed, 'status'],
    ['attention beats an idle agent', { ...session, attention, process }, idle, 'attention'],
    ['an idle agent beats the running dot', { ...session, process }, idle, 'status'],
    ['an agent that reports nothing keeps the running dot', { ...session, process }, silent, 'running'],
    ['interrupted beats running', { ...session, interrupted, process }, null, 'interrupted'],
    ['running', { ...session, process }, null, 'running'],
    ['exited', { ...session, alive: false }, null, 'exited'],
    ['shell', session, null, 'shell'],
    ['no session yet', undefined, null, 'shell'],
  ]

  test.each(rows)('%s', (_name, row, status, signal) => {
    expect(sidebarSignal(row, status)).toBe(signal)
  })
})

describe('agentCounts', () => {
  const session = (agentState: AgentState | null | undefined, progress: SessionInfo['progress'] = null) =>
    ({ agentState, progress }) as SessionInfo

  const cases: [string, SessionInfo | undefined, 'waiting' | 'working' | 'idle' | null][] = [
    ['working', session(agentState('working', 'turn')), 'working'],
    ['waiting', session(agentState('waiting', 'permission')), 'waiting'],
    ['idle', session(agentState('idle', 'finished')), 'idle'],
    ['failed, as idle', session(agentState('idle', 'error')), 'idle'],
    ['no report, busy', session(null, 'busy'), null],
    ['no report, error', session(null, 'error'), null],
    ['undefined state, busy', session(undefined, 'busy'), null],
    ['no session', undefined, null],
  ]

  test.each(cases)('%s', (_name, info, bucket) => {
    const surface = makeSurface()
    const sessions = info ? { [surface.id]: info } : {}
    const expected = { waiting: 0, working: 0, idle: 0, ...(bucket && { [bucket]: 1 }) }
    expect(agentCounts(makeWorkspace('ws', '/w', makePane([surface])), sessions)).toEqual(expected)
  })

  test('counts each terminal in every pane once, active tab or not, and nothing else', () => {
    const background = makeSurface()
    const active = makeSurface()
    const split = makeSurface()
    const pulls: Surface = makeSurface('pulls')
    const elsewhere = makeSurface()
    const root = {
      type: 'split',
      id: 'split',
      direction: 'row',
      ratio: 0.5,
      a: makePane([active, background]),
      b: makePane([split, pulls]),
    } as const
    const working = session(agentState('working', 'turn'))

    const counts = agentCounts(makeWorkspace('ws', '/w', root), {
      [background.id]: working,
      [active.id]: working,
      [split.id]: session(agentState('waiting', 'question')),
      [pulls.id]: working,
      [elsewhere.id]: working,
    })

    expect(counts).toEqual({ waiting: 1, working: 2, idle: 0 })
  })
})

describe('agentCountsLabel', () => {
  test.each([
    [{ working: 2, waiting: 1, idle: 0 }, '2 agents working, 1 waiting'],
    [{ working: 1, waiting: 0, idle: 0 }, '1 agent working'],
    [{ working: 0, waiting: 1, idle: 3 }, '1 agent waiting, 3 idle'],
    [{ working: 0, waiting: 0, idle: 0 }, null],
  ])('words %j', (counts, label) => {
    expect(agentCountsLabel(counts)).toBe(label)
  })
})
