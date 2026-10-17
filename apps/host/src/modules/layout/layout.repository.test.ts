import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LayoutRepository } from './layout.repository'

const dirs: string[] = []

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-store-'))
  dirs.push(dir)
  return join(dir, '.data', 'state.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('LayoutRepository', () => {
  test('seeds a project workspace when there is no saved file', () => {
    const store = new LayoutRepository(tempFile(), '/work/my-project')
    expect(store.state.workspaces.map((w) => w.name)).toEqual(['my-project', 'home'])
  })

  test('falls back to the seed when the saved file is corrupt', () => {
    const file = tempFile()
    new LayoutRepository(file, '/p').flush()
    writeFileSync(file, '{ not json')
    expect(new LayoutRepository(file, '/work/p').state.workspaces[0].name).toBe('p')
  })

  test('bumps rev on set and restores the saved state after a restart', () => {
    const file = tempFile()
    const store = new LayoutRepository(file, '/p')
    store.set({ ...store.state, workspaces: store.state.workspaces.slice(1) })
    store.flush()
    expect(store.state.rev).toBe(2)
    expect(new LayoutRepository(file, '/p').state).toEqual(store.state)
  })
})
