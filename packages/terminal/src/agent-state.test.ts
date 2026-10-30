import { describe, expect, test } from 'bun:test'
import type { AgentReason, AgentRef, AgentState, AgentStateName } from '@orch/shared'
import { type AgentSignals, deriveAgentState } from './agent-state'

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
})
