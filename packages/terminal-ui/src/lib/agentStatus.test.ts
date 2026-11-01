import { describe, expect, test } from 'bun:test'
import type { AgentReason, AgentState, AgentStateName, SessionInfo } from '@orch/shared'
import { type AgentStatusKind, agentStatus, type SidebarSignal, sidebarSignal, withStatus } from './agentStatus'

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
    [agentState('idle', 'detected'), null, 'idle'],
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
    expect(status(agentState('idle', 'detected', 'signals'))).toMatchObject({
      label: 'Claude Code idle',
      tooltip: 'Claude Code idle (terminal signals)',
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

  const rows: [string, Parameters<typeof sidebarSignal>[0], Parameters<typeof sidebarSignal>[1], SidebarSignal][] = [
    ['working beats attention', { ...session, attention }, working, 'status'],
    ['waiting beats attention', { ...session, attention }, waiting, 'status'],
    ['failed beats attention', { ...session, attention }, failed, 'status'],
    ['attention beats an idle agent', { ...session, attention, process }, idle, 'attention'],
    ['an idle agent beats the running dot', { ...session, process }, idle, 'status'],
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
