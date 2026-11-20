import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { AGENT_DEFINITIONS, AGENT_KINDS } from './registry'
import { AGENTS } from './runtime'
import { stripAgentGlyphs } from './titles'

test('every definition has one matching runtime adapter', () => {
  expect(AGENTS.map((adapter) => adapter.kind)).toEqual(AGENT_KINDS)
  for (const adapter of AGENTS) expect(AGENT_DEFINITIONS[adapter.kind].kind).toBe(adapter.kind)
})

test("every registered agent's title loses its glyphs and keeps its text", () => {
  for (const kind of AGENT_KINDS) {
    expect(stripAgentGlyphs('⠋ repo · main ✳', kind)).toBe('repo · main')
  }
})

test('the browser entry builds without filesystem or process implementations', async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'index.ts')], target: 'browser' })
  expect(result.success).toBe(true)
  const bundle = await result.outputs[0].text()
  expect(bundle).not.toContain('findSessionId')
})
