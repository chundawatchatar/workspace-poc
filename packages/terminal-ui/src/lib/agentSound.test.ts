import { expect, test } from 'bun:test'
import type { AgentReason, AgentStateName, SessionInfo } from '@orch/shared'
import { type SoundCue, soundCue } from './agentSound'

/** A live, tracked Claude Code session in `state`, with whatever else `patch` changes. */
function session(state: AgentStateName | null, reason: AgentReason = 'turn', patch: Partial<SessionInfo> = {}) {
  return {
    id: 's',
    title: 'repo',
    alive: true,
    interrupted: null,
    agentTracking: true,
    progress: null,
    agent: { kind: 'claude', sessionId: null, cwd: '/w' },
    agentState: state && { state, reason, since: 1 },
    ...patch,
  } as SessionInfo
}

test('a chime when an agent starts waiting or finishes a turn, and only then', () => {
  const cases: [SessionInfo | undefined, SessionInfo, SoundCue | null][] = [
    [session('working'), session('waiting', 'permission'), 'waiting'],
    [session('idle', 'finished'), session('waiting', 'question'), 'waiting'],
    [session('waiting', 'permission'), session('waiting', 'question'), null],
    [session('working'), session('idle', 'finished'), 'finished'],
    [session('working'), session('idle', 'error'), 'finished'],
    [session('working'), session(null), null],
    [session('working'), session('working', 'turn'), null],
    [session('waiting', 'permission'), session('working'), null],
    [session('waiting', 'permission'), session('idle', 'finished'), 'finished'],
    [session('waiting', 'question'), session('idle', 'error'), 'finished'],
    [session('idle', 'finished'), session('idle', 'finished'), null],
  ]
  for (const [previous, next, cue] of cases) expect(soundCue(previous, next)).toBe(cue)
})

test('no chime for a new session, an interrupted turn, an exited shell, no agent, or tracking switched off', () => {
  const working = session('working')
  expect(soundCue(undefined, session('waiting', 'permission'))).toBeNull()
  // An interrupted turn goes back to `ready`.
  expect(soundCue(working, session('idle', 'ready'))).toBeNull()
  expect(soundCue(working, session('idle', 'finished', { alive: false }))).toBeNull()
  expect(soundCue(working, session('waiting', 'permission', { agent: null }))).toBeNull()
  expect(soundCue(working, session('waiting', 'permission', { agentTracking: false }))).toBeNull()
})
