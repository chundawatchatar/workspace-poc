import { describe, expect, test } from 'bun:test'
import type { AgentKind } from '@orch/shared'
import { trustQuestion, unansweredAgent } from './agentTracking'

const running = (kind: AgentKind) => ({ agent: { kind, sessionId: null, cwd: '/w' } })

describe('unansweredAgent', () => {
  test('asks about Claude Code or Codex only until that kind is answered, and never before the answers load', () => {
    const none = { claude: null, codex: null }
    expect(unansweredAgent(running('claude'), none)).toBe('claude')
    expect(unansweredAgent(running('codex'), none)).toBe('codex')
    expect(unansweredAgent(running('claude'), { claude: 'off', codex: null })).toBeNull()
    expect(unansweredAgent(running('codex'), { claude: null, codex: 'on' })).toBeNull()
    expect(unansweredAgent(running('opencode'), none)).toBeNull()
    expect(unansweredAgent({ agent: null }, none)).toBeNull()
    expect(unansweredAgent(undefined, none)).toBeNull()
    expect(unansweredAgent(running('claude'), undefined)).toBeNull()
  })

  test('the question names the agent and says it applies to agents started afterwards', () => {
    const { title, body } = trustQuestion('codex')
    expect(title).toBe("Track Codex's status with hooks?")
    expect(body).toStartWith('This adds hooks to Codex sessions started in this app, for those sessions only.')
    expect(body).toContain('started after you answer')
  })
})
