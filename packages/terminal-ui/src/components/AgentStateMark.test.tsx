import { describe, expect, test } from 'bun:test'
import type { AgentStateName, SessionInfo } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import { type AgentStatus, agentStatus } from '../lib/agentStatus'
import { AgentStateMark } from './AgentStateMark'

const agent = { kind: 'claude', sessionId: null, cwd: '/w' } as const

function status(state: AgentStateName, progress: SessionInfo['progress'] = null) {
  const agentState = { state, reason: 'tool', source: 'hooks', since: 1 } as const
  return agentStatus({
    agentState,
    progress,
    agent,
    title: 'repo',
    alive: true,
    interrupted: null,
    agentTracking: true,
  }) as AgentStatus
}

describe('AgentStateMark', () => {
  test('each kind is an image named by its status, with its own shape, and only working spins in orange', () => {
    const statuses = [status('working'), status('waiting'), status('idle'), status('idle', 'error')]
    expect(statuses.map((s) => s.kind)).toEqual(['working', 'waiting', 'idle', 'failed'])

    const shapes = new Set<string>()
    for (const s of statuses) {
      const { unmount } = render(<AgentStateMark status={s} size={10} />)
      const mark = screen.getByRole('img', { name: s.label })
      shapes.add(mark.innerHTML)
      if (s.kind === 'working') {
        expect(mark).toHaveClass('animate-spin', 'text-busy')
      } else {
        expect(mark).not.toHaveClass('animate-spin')
        expect(mark).not.toHaveClass('text-busy')
      }
      if (s.kind === 'waiting') expect(mark).toHaveClass('text-warn')
      unmount()
    }
    expect(shapes.size).toBe(4)
  })

  test('idle is a faint hollow circle drawn at the size it is given', () => {
    const idle = status('idle')
    expect(idle.label).toBe('Claude Code idle')
    for (const size of [10, 13]) {
      const { unmount } = render(<AgentStateMark status={idle} size={size} />)
      const mark = screen.getByRole('img', { name: idle.label })
      expect(mark).toHaveClass('text-faint')
      expect(mark).not.toHaveClass('animate-spin')
      expect(mark).toHaveAttribute('fill', 'none')
      expect(mark).toHaveAttribute('width', String(size))
      expect(mark).toHaveAttribute('height', String(size))
      expect(mark.querySelectorAll('circle')).toHaveLength(1)
      expect(mark.querySelectorAll('path, line, rect')).toHaveLength(0)
      unmount()
    }
  })

  test('on the selected tile the idle mark takes the on-accent colour', () => {
    const idle = status('idle')
    render(<AgentStateMark status={idle} size={10} onAccent />)
    const mark = screen.getByRole('img', { name: idle.label })
    expect(mark).toHaveClass('text-on-accent')
    expect(mark).not.toHaveClass('text-faint')
  })

  test('on the selected tile the working mark still spins, in the on-accent colour', () => {
    const working = status('working')
    render(<AgentStateMark status={working} size={10} onAccent />)
    const mark = screen.getByRole('img', { name: working.label })
    expect(mark).toHaveClass('animate-spin', 'text-on-accent')
    expect(mark).not.toHaveClass('text-busy')
  })
})
