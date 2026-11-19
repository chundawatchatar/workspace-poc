import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { AGENT_DEFINITIONS, AGENT_KINDS, HOOK_AGENT_KINDS } from './registry'
import { AGENTS, trackedKinds } from './runtime'
import { stripAgentGlyphs, titleSpins } from './titles'

test('every definition has one matching runtime adapter and truthful capabilities', () => {
  expect(AGENTS.map((adapter) => adapter.kind)).toEqual(AGENT_KINDS)
  expect(trackedKinds()).toEqual(HOOK_AGENT_KINDS)
  for (const adapter of AGENTS) {
    const definition = AGENT_DEFINITIONS[adapter.kind]
    expect(definition.kind).toBe(adapter.kind)
    expect(definition.capabilities.hooks).toBe('tracking' in adapter)
  }
})

test('every registered agent recognises its working titles while retaining meaningful title text', () => {
  for (const kind of AGENT_KINDS) {
    expect(titleSpins('  ⠋ Fix login', kind)).toBe(true)
    expect(titleSpins('✳ Ready', kind)).toBe(false)
    expect(titleSpins('⠀ Notes', kind)).toBe(false)
    expect(stripAgentGlyphs('⠋ repo · main ✳', kind)).toBe('repo · main')
  }
})

test('the browser entry builds without filesystem, process or tracking implementations', async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'index.ts')], target: 'browser' })
  expect(result.success).toBe(true)
  const bundle = await result.outputs[0].text()
  expect(bundle).not.toContain('ORCH_AGENT_TOKEN')
  expect(bundle).not.toContain('findSessionId')
})
