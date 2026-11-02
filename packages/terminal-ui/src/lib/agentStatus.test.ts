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

function agentState(state: AgentStateName, reason: AgentReason, source: AgentState['source'] = 'hooks'): AgentState {
  return { state, reason, source, since: 1 }
}

describe('agentStatus', () => {
  const kinds: [AgentState | null | undefined, SessionInfo['progress'], AgentStatusKind | undefined][] = [
    [agentState('working', 'tool'), null, 'working'],
    [agentState('working', 'progress'), 'error', 'working'],
    [agentState('waiting', 'permission'), 'busy', 'waiting'],
    [agentState('waiting', 'attention'), 'error', 'waiting'],
    [agentState('idle', 'error'), 'error', 'failed'],
    [agentState('idle', 'finished'), 'error', 'failed'],
    [agentState('idle', 'finished'), 'busy', 'idle'],
    [agentState('idle', 'interrupted'), null, 'idle'],
    [agentState('idle', 'detected', 'signals'), null, undefined],
    [agentState('idle', 'detected', 'signals'), 'busy', 'working'],
    [agentState('idle', 'error', 'signals'), 'error', 'failed'],
    [null, 'busy', 'working'],
    [undefined, 'error', 'failed'],
    [null, null, undefined],
    [undefined, null, undefined],
  ]

  test.each(kinds)('picks the kind from state %j and progress %j', (state, progress, kind) => {
    expect(agentStatus({ agentState: state, progress, agent: claude })?.kind).toBe(kind)
  })

  test('shows nothing for a terminal with no session yet', () => {
    expect(agentStatus(undefined)).toBeNull()
  })

  test('keeps the plain labels for a program with no agent', () => {
    expect(agentStatus({ progress: 'busy', agent: null })).toEqual({
      kind: 'working',
      label: 'Working',
      tooltip: 'Working',
    })
    expect(agentStatus({ progress: 'error', agent: null })?.label).toBe('Failed')
  })

  test('names the agent, state, reason and source', () => {
    const status = (
      state: AgentState,
      progress: SessionInfo['progress'] = null,
      agent: typeof claude | typeof codex = claude,
    ) => agentStatus({ agentState: state, progress, agent })

    expect(status(agentState('waiting', 'permission'))?.tooltip).toBe(
      'Claude Code waiting for you: needs permission (agent hooks)',
    )
    expect(status(agentState('waiting', 'attention', 'signals'), null, codex)).toMatchObject({
      label: 'Codex waiting for you',
      tooltip: 'Codex waiting for you: asked for attention (terminal signals)',
    })
    expect(status(agentState('idle', 'detected'))).toMatchObject({
      label: 'Claude Code idle',
      tooltip: 'Claude Code idle (agent hooks)',
    })
  })
})

test('withStatus adds the status to the tooltip, and nothing without one', () => {
  const status = agentStatus({ progress: 'busy', agent: null })
  expect(withStatus('npm test', status)).toBe('npm test\nWorking')
  expect(withStatus('npm test', null)).toBe('npm test')
})

describe('sidebarSignal', () => {
  const session = { attention: null, interrupted: null, process: null, alive: true }
  const attention = { at: 1, message: 'Done' }
  const interrupted = { agent: claude, cwd: '/w', command: 'claude' }
  const process = { pid: 1, name: 'claude', command: 'claude', startedAt: 1 }
  const idle = agentStatus({ agentState: agentState('idle', 'finished'), progress: null, agent: claude })
  const waiting = agentStatus({ agentState: agentState('waiting', 'question'), progress: null, agent: claude })
  const working = agentStatus({ progress: 'busy', agent: null })
  const failed = agentStatus({ progress: 'error', agent: null })
  const signalIdle = agentStatus({
    agentState: agentState('idle', 'detected', 'signals'),
    progress: null,
    agent: claude,
  })

  const rows: [string, Parameters<typeof sidebarSignal>[0], Parameters<typeof sidebarSignal>[1], SidebarSignal][] = [
    ['working beats attention', { ...session, attention }, working, 'status'],
    ['waiting beats attention', { ...session, attention }, waiting, 'status'],
    ['failed beats attention', { ...session, attention }, failed, 'status'],
    ['attention beats an idle agent', { ...session, attention, process }, idle, 'attention'],
    ['an idle agent beats the running dot', { ...session, process }, idle, 'status'],
    ['an idle state from signals keeps the running dot', { ...session, process }, signalIdle, 'running'],
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
    ['working from hooks', session(agentState('working', 'tool')), 'working'],
    ['working from signals', session(agentState('working', 'progress', 'signals')), 'working'],
    ['waiting from hooks', session(agentState('waiting', 'permission')), 'waiting'],
    ['waiting from signals', session(agentState('waiting', 'attention', 'signals')), 'waiting'],
    ['idle from hooks', session(agentState('idle', 'finished')), 'idle'],
    ['failed idle from hooks', session(agentState('idle', 'error'), 'error'), 'idle'],
    ['idle from signals', session(agentState('idle', 'detected', 'signals')), null],
    ['null state, busy', session(null, 'busy'), null],
    ['null state, error', session(null, 'error'), null],
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
    const working = session(agentState('working', 'tool'))

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
