import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRef, ProcessInfo } from '@orch/shared'
import { detectAgent, resumeCommand } from './agents'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'orch-agents-'))
  homes.push(home)
  return home
}

function write(file: string, text: string, mtime?: number) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  if (mtime) utimesSync(file, mtime / 1000, mtime / 1000)
}

const started = Date.now() - 60_000
const proc = (command: string, pid = 4242): ProcessInfo => ({
  pid,
  name: command.split(' ')[0],
  command,
  startedAt: started,
})

test('takes the conversation from the command line, and builds a resume command from it', () => {
  const home = tempHome()
  expect(detectAgent(proc('claude --resume abc-123'), '/repo', home)).toEqual({
    kind: 'claude',
    sessionId: 'abc-123',
    cwd: '/repo',
  })
  expect(detectAgent(proc('codex resume 01a1-ff'), '/repo', home)?.sessionId).toBe('01a1-ff')
  expect(detectAgent(proc('opencode --session=ses_9'), '/repo', home)?.sessionId).toBe('ses_9')
  expect(resumeCommand({ kind: 'codex', sessionId: '01a1-ff', cwd: '/repo' })).toBe('codex resume 01a1-ff')
  expect(resumeCommand({ kind: 'cursor', sessionId: null, cwd: '/repo' })).toBe('cursor-agent resume')
  expect(detectAgent(proc('vim notes.md'), '/repo', home)).toBeNull()
})

test("finds Claude Code's conversation from its per-process file, once its first message is saved", () => {
  const home = tempHome()
  write(
    join(home, '.claude', 'sessions', '4242.json'),
    JSON.stringify({ pid: 4242, sessionId: 'c1aude', cwd: '/my.repo' }),
  )
  const fresh = detectAgent(proc('claude'), '/my.repo', home)
  expect(fresh?.sessionId).toBeNull()
  expect(resumeCommand(fresh as AgentRef)).toBe('claude')

  write(join(home, '.claude', 'projects', '-my-repo', 'c1aude.jsonl'), '{}\n')
  expect(detectAgent(proc('claude'), '/my.repo', home)?.sessionId).toBe('c1aude')
  expect(detectAgent(proc('claude', 7), '/my.repo', home)?.sessionId).toBeNull()
  // After `/resume` or `/clear`, the per-process file names the current conversation, not the startup arguments,
  // even when it is a new one with nothing to resume yet.
  expect(detectAgent(proc('claude --resume older'), '/my.repo', home)?.sessionId).toBe('c1aude')
  write(
    join(home, '.claude', 'sessions', '4242.json'),
    JSON.stringify({ pid: 4242, sessionId: 'cleared', cwd: '/my.repo' }),
  )
  expect(detectAgent(proc('claude --resume older'), '/my.repo', home)?.sessionId).toBeNull()
  // Run by node, it is still recognised by its script.
  expect(detectAgent(proc('node /usr/local/bin/claude --resume abc', 99), '/elsewhere', home)).toEqual({
    kind: 'claude',
    sessionId: 'abc',
    cwd: '/elsewhere',
  })
})

test('picks the Codex rollout of this folder written since the process started', () => {
  const home = tempHome()
  const now = new Date()
  const day = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`
  const dir = join(home, '.codex', 'sessions', day)
  const meta = (id: string, cwd: string) => `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n{}\n`
  write(join(dir, 'rollout-a.jsonl'), meta('other-folder', '/elsewhere'))
  write(join(dir, 'rollout-b.jsonl'), meta('too-old', '/repo'), started - 3_600_000)
  write(join(dir, 'rollout-c.jsonl'), meta('this-one', '/repo'))
  expect(detectAgent(proc('codex'), '/repo', home)?.sessionId).toBe('this-one')
  // With two Codex processes in the folder, neither can tell which rollout is its own.
  expect(detectAgent(proc('codex'), '/repo', home, false)?.sessionId).toBeNull()
  // One started with `codex resume <id>` that has since moved on is in its newest rollout.
  expect(detectAgent(proc('codex resume too-old'), '/repo', home)?.sessionId).toBe('this-one')
})

test('finds a resumed Codex conversation in the folder of the day it began', () => {
  const home = tempHome()
  const begun = new Date(Date.now() - 10 * 86_400_000)
  const day = `${begun.getFullYear()}/${String(begun.getMonth() + 1).padStart(2, '0')}/${String(begun.getDate()).padStart(2, '0')}`
  write(
    join(home, '.codex', 'sessions', day, 'rollout-old.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'resumed', cwd: '/repo' } })}\n`,
  )
  expect(detectAgent(proc('codex resume --last'), '/repo', home)?.sessionId).toBe('resumed')

  // Switching back to today's conversation makes it the newest again.
  const now = new Date()
  const today = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`
  write(
    join(home, '.codex', 'sessions', today, 'rollout-new.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'today', cwd: '/repo' } })}\n`,
    Date.now() - 20_000,
  )
  expect(detectAgent(proc('codex'), '/repo', home)?.sessionId).toBe('resumed')
})

test('never puts an unsafe id into a command line', () => {
  const home = tempHome()
  expect(detectAgent(proc('claude --resume x;rm'), '/repo', home)?.sessionId).toBeNull()
  expect(resumeCommand({ kind: 'claude', sessionId: '$(boom)', cwd: '/repo' })).toBe('claude')
})
