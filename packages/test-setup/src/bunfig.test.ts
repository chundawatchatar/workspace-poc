import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Bun has no `extends` for bunfig.toml, so every workspace keeps its own copy of the test settings. This keeps the
// copies in step: it finds them itself, so a new workspace needs no list updated here. It reads the whole repo, but
// like every test here it runs only through `bun run test` or from this folder, not from another workspace's.

const root = join(import.meta.dir, '../../..')

/**
 * The `[test]` settings every workspace of a kind shares. A workspace is React when it has its own `test/happydom.ts`,
 * not when its bunfig preloads the React setup, so one that drops that preload fails on it instead of being checked as
 * server-side. A workspace may add its own items after a list's shared ones (`apps/client` adds the MSW preload and
 * two ignores), but never change or drop a shared setting or add one of its own.
 */
const shared = {
  react: {
    preload: ['./test/happydom.ts', '@orch/test-setup/react'],
    coverageSkipTestFiles: true,
    coveragePathIgnorePatterns: ['../**', 'test/**'],
    coverageReporter: ['text', 'lcov'],
    coverageDir: 'coverage',
  },
  server: {
    coverageSkipTestFiles: true,
    coveragePathIgnorePatterns: ['../**'],
    coverageReporter: ['text', 'lcov'],
    coverageDir: 'coverage',
  },
} satisfies Record<string, Record<string, unknown>>

type Settings = Record<string, unknown>

/** Every workspace folder, relative to the root, from the root `package.json` globs. */
function workspaces(): string[] {
  const { workspaces: patterns } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces: string[]
  }
  return patterns
    .flatMap((pattern) => [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })])
    .map((file) => dirname(file))
    .sort()
}

function hasTests(dir: string): boolean {
  const { scripts } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return scripts?.test !== undefined
}

function testSettings(dir: string): Settings {
  const config = Bun.TOML.parse(readFileSync(join(root, dir, 'bunfig.toml'), 'utf8')) as { test?: Settings }
  return config.test ?? {}
}

/** The settings cut down to what the kind shares: each list to its shared length, so a workspace's own additions pass. */
function sharedPart(settings: Settings, kind: Settings): Settings {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => {
      const base = kind[key]
      return [key, Array.isArray(value) && Array.isArray(base) ? value.slice(0, base.length) : value]
    }),
  )
}

const tested = workspaces().filter(hasTests)

describe('workspace bunfig.toml', () => {
  test('every workspace with tests has one, since Bun reads only the one in the folder it runs in', () => {
    expect(tested.filter((dir) => !existsSync(join(root, dir, 'bunfig.toml')))).toEqual([])
  })

  for (const dir of tested.filter((dir) => existsSync(join(root, dir, 'bunfig.toml')))) {
    test(`${dir} has the same settings as the other workspaces of its kind`, () => {
      const kind = existsSync(join(root, dir, 'test/happydom.ts')) ? shared.react : shared.server
      expect(sharedPart(testSettings(dir), kind)).toEqual(kind)
    })
  }
})
