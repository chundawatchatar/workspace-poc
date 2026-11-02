import { describe, expect, test } from 'bun:test'
import type { AgentReason, AgentRef, AgentState, AgentStateName } from '@orch/shared'
import { AGENT_INTERRUPT_MS, type AgentHook, type AgentSignals, deriveAgentState } from './agent-state'

const agent: AgentRef = { kind: 'claude', sessionId: null, cwd: '/repo' }
const attention = { at: 1, message: 'Claude needs you' }
type Expected = [AgentStateName, AgentReason] | null

const result = (state: AgentStateName, reason: AgentReason, since: number): AgentState => ({
  state,
  reason,
  source: 'signals',
  since,
})

function signals(patch: Partial<AgentSignals> = {}): AgentSignals {
  return { agent, alive: true, interrupted: null, progress: null, attention: null, ...patch }
}

describe('deriveAgentState', () => {
  test('applies the baseline rules in order', () => {
    const interrupted = { agent, cwd: '/repo', command: 'claude' }
    const cases: [Partial<AgentSignals>, Expected][] = [
      [{ agent: null, progress: 'busy', attention }, null],
      [{ alive: false, progress: 'busy', attention }, null],
      [{ interrupted, progress: 'busy', attention }, null],
      [{ progress: 'busy', attention }, ['working', 'progress']],
      [{ attention }, ['waiting', 'attention']],
      [{ attention, progress: 'error' }, ['waiting', 'attention']],
      [{ progress: 'error' }, ['idle', 'error']],
      [{}, ['idle', 'detected']],
    ]
    for (const [patch, expected] of cases) {
      expect(deriveAgentState(signals(patch), null, 5)).toEqual(expected && result(...expected, 5))
    }
  })

  test('keeps since while the state stays the same, and starts it again on each change', () => {
    const steps: [Partial<AgentSignals>, number, [AgentStateName, AgentReason, number] | null][] = [
      [{}, 10, ['idle', 'detected', 10]],
      [{ progress: 'busy' }, 20, ['working', 'progress', 20]],
      [{}, 30, ['idle', 'detected', 30]],
      [{ progress: 'error' }, 35, ['idle', 'error', 30]],
      [{ attention }, 40, ['waiting', 'attention', 40]],
      [{}, 50, ['idle', 'detected', 50]],
      [{ agent: null }, 60, null],
      [{}, 70, ['idle', 'detected', 70]],
    ]
    let previous: AgentState | null = null
    for (const [patch, now, expected] of steps) {
      previous = deriveAgentState(signals(patch), previous, now)
      expect(previous).toEqual(expected && result(...expected))
    }
  })

  const hook = (patch: Partial<AgentHook> = {}): AgentHook => ({
    agent: 'claude',
    state: 'waiting',
    reason: 'permission',
    at: 100,
    ...patch,
  })
  const derive = (patch: Partial<AgentSignals>, now = 5000): string[] | null => {
    const state = deriveAgentState(signals(patch), null, now)
    return state && [state.state, state.reason, state.source]
  }

  test('a hook event wins over progress and attention, but never brings back a state that is gone', () => {
    expect(derive({ agentHook: hook(), progress: 'busy', attention })).toEqual(['waiting', 'permission', 'hooks'])
    expect(derive({ agentHook: hook(), agent: null })).toBeNull()
    expect(derive({ agentHook: hook(), alive: false })).toBeNull()
    expect(derive({ agentHook: hook(), interrupted: { agent, cwd: '/repo', command: 'claude' } })).toBeNull()
    expect(derive({ agentHook: hook({ agent: 'codex' }), progress: 'busy' })).toEqual([
      'working',
      'progress',
      'signals',
    ])
    expect(derive({ agentHook: null })).toEqual(['idle', 'detected', 'signals'])
  })

  test('for Codex the baseline wins while it says working or waiting, and otherwise a finished turn shows', () => {
    const codex: AgentRef = { ...agent, kind: 'codex' }
    const finished = hook({ agent: 'codex', state: 'idle', reason: 'finished' })
    expect(derive({ agent: codex, agentHook: finished, progress: 'busy' })).toEqual(['working', 'progress', 'signals'])
    expect(derive({ agent: codex, agentHook: finished, attention })).toEqual(['waiting', 'attention', 'signals'])
    expect(derive({ agent: codex, agentHook: finished })).toEqual(['idle', 'finished', 'hooks'])
    expect(derive({ agent: codex, agentHook: finished, progress: 'error' })).toEqual(['idle', 'finished', 'hooks'])
  })

  test('attention the agent raised is a notification, never a waiting state by itself', () => {
    const codex: AgentRef = { ...agent, kind: 'codex' }
    const finished = hook({ agent: 'codex', state: 'idle', reason: 'finished' })
    const notified = { at: 1, message: 'Codex finished', from: 'agent' as const }
    expect(derive({ agent: codex, agentHook: finished, attention: notified })).toEqual(['idle', 'finished', 'hooks'])
    expect(derive({ attention: notified })).toEqual(['idle', 'detected', 'signals'])
    expect(derive({ attention })).toEqual(['waiting', 'attention', 'signals'])
  })

  test('a working hook gives way to interrupted only after progress ended and hooks stayed silent', () => {
    const agentHook = hook({ state: 'working', reason: 'tool', at: 100 })
    const ended = 200
    const interrupted = ['idle', 'interrupted', 'signals']
    const working = ['working', 'tool', 'hooks']
    expect(derive({ agentHook, progressEndedAt: ended }, ended + AGENT_INTERRUPT_MS)).toEqual(interrupted)
    expect(derive({ agentHook, progressEndedAt: ended }, ended + AGENT_INTERRUPT_MS - 1)).toEqual(working)
    expect(derive({ agentHook }, 1_000_000)).toEqual(working)
    const later = hook({ state: 'working', reason: 'tool', at: 300 })
    expect(derive({ agentHook: later, progressEndedAt: ended }, 1_000_000)).toEqual(working)
    expect(derive({ agentHook: hook({ at: 100 }), progressEndedAt: ended }, 1_000_000)).toEqual([
      'waiting',
      'permission',
      'hooks',
    ])
  })
})
