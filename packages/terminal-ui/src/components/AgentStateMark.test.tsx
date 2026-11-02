import { describe, expect, test } from 'bun:test'
import type { AgentStateName, SessionInfo } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import { type AgentStatus, agentStatus } from '../lib/agentStatus'
import { AgentStateMark } from './AgentStateMark'

const agent = { kind: 'claude', sessionId: null, cwd: '/w' } as const

function status(state: AgentStateName, progress: SessionInfo['progress'] = null) {
  const agentState = { state, reason: 'tool', source: 'hooks', since: 1 } as const
  return agentStatus({ agentState, progress, agent }) as AgentStatus
}

describe('AgentStateMark', () => {
  test('each kind is an image named by its status', () => {
    const statuses = [status('working'), status('waiting'), status('idle'), status('idle', 'error')]
    expect(statuses.map((s) => s.kind)).toEqual(['working', 'waiting', 'idle', 'failed'])

    for (const s of statuses) {
      const { unmount } = render(<AgentStateMark status={s} size={10} />)
      expect(screen.getByRole('img', { name: s.label })).toBeInTheDocument()
      unmount()
    }
  })
})
