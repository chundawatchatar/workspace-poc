import { expect, test } from 'bun:test'
import type { AgentRef, AgentState } from '@orch/shared'
import { type AgentSignals, deriveAgentState } from './agent-state'

const agent: AgentRef = { kind: 'claude', sessionId: null, cwd: '/repo' }
const signals = (patch: Partial<AgentSignals> = {}): AgentSignals => ({
  agent,
  alive: true,
  interrupted: null,
  agentReport: { state: 'waiting', reason: 'permission', at: 1 },
  ...patch,
})

test("is the foreground agent's own report, and nothing without an agent or a report", () => {
  expect(deriveAgentState(signals(), null, 5)).toEqual({ state: 'waiting', reason: 'permission', since: 5 })
  expect(deriveAgentState(signals({ agentReport: null }), null, 5)).toBeNull()
  expect(deriveAgentState(signals({ agent: null }), null, 5)).toBeNull()
  expect(deriveAgentState(signals({ alive: false }), null, 5)).toBeNull()
  expect(deriveAgentState(signals({ interrupted: { agent, cwd: '/repo', command: 'claude' } }), null, 5)).toBeNull()
})

test('keeps since while the state stays the same, and starts it again on each change', () => {
  const steps: [AgentSignals['agentReport'], number, number][] = [
    [{ state: 'working', reason: 'turn', at: 1 }, 10, 10],
    [{ state: 'waiting', reason: 'question', at: 2 }, 20, 20],
    [{ state: 'waiting', reason: 'permission', at: 3 }, 30, 20],
    [{ state: 'idle', reason: 'finished', at: 4 }, 40, 40],
  ]
  let previous: AgentState | null = null
  for (const [agentReport, now, since] of steps) {
    previous = deriveAgentState(signals({ agentReport }), previous, now)
    expect(previous?.since).toBe(since)
  }
})
