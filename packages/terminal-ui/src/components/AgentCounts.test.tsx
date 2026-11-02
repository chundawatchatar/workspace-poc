import { describe, expect, test } from 'bun:test'
import { makePane, makeSurface, makeWorkspace, type SessionInfo } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import { agentCounts } from '../lib/agentStatus'
import { AgentCounts } from './AgentCounts'

describe('AgentCounts', () => {
  test('renders nothing for a workspace with no agents to state', () => {
    const noTerminals = makeWorkspace('ws', '/w', makePane([makeSurface('pulls')]))
    const shell = makeSurface()
    const signalsIdle = makeSurface()
    const onlyShells = makeWorkspace('ws', '/w', makePane([shell]))
    const onlySignalsIdle = makeWorkspace('ws', '/w', makePane([signalsIdle]))
    const sessions = {
      [shell.id]: { agentState: null, progress: null },
      [signalsIdle.id]: {
        agentState: { state: 'idle', reason: 'detected', source: 'signals', since: 1 },
        progress: null,
      },
    } as unknown as Record<string, SessionInfo>

    for (const workspace of [noTerminals, onlyShells, onlySignalsIdle]) {
      const { container, unmount } = render(<AgentCounts counts={agentCounts(workspace, sessions)} active={false} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  test('says the counts in words and hides the drawing, which shows waiting, working and idle in that order', () => {
    const { rerender } = render(<AgentCounts counts={{ waiting: 1, working: 2, idle: 0 }} active={false} />)
    expect(screen.getByText('2 agents working, 1 waiting')).toBeInTheDocument()
    const drawing = screen.getByTitle('2 agents working, 1 waiting')
    expect(drawing).toHaveAttribute('aria-hidden', 'true')
    expect(drawing).toHaveTextContent(/^12$/)

    rerender(<AgentCounts counts={{ waiting: 1, working: 2, idle: 3 }} active={false} />)
    expect(screen.getByText('2 agents working, 1 waiting, 3 idle')).toBeInTheDocument()
    expect(screen.getByTitle('2 agents working, 1 waiting, 3 idle')).toHaveTextContent(/^123$/)

    rerender(<AgentCounts counts={{ waiting: 0, working: 0, idle: 3 }} active={false} />)
    expect(screen.getByTitle('3 agents idle')).toHaveTextContent(/^3$/)
  })
})
