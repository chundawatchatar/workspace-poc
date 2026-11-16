import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildIdFor,
  chooseTargets,
  compileArgs,
  type LauncherTemplate,
  launcherManifest,
  PLATFORMS,
  platformKey,
  platformManifest,
} from './platforms'

const template = JSON.parse(readFileSync(join(import.meta.dir, 'npm/corch/package.json'), 'utf8')) as LauncherTemplate
const mac = { platform: 'darwin', arch: 'arm64' }
const linux = { platform: 'linux', arch: 'x64' }

/** The keys a choice builds, or its error. */
function chosen(argv: string[], host = mac) {
  const choice = chooseTargets(argv, host)
  return choice.ok ? choice.platforms.map(platformKey) : choice.error
}

describe('package:host targets', () => {
  test('are the four platforms, each with its Bun target and npm name', () => {
    expect(PLATFORMS.map((target) => [platformKey(target), target.bunTarget, target.npmName])).toEqual([
      ['darwin-arm64', 'bun-darwin-arm64', 'corch-darwin-arm64'],
      ['darwin-x64', 'bun-darwin-x64', 'corch-darwin-x64'],
      ['linux-arm64', 'bun-linux-arm64', 'corch-linux-arm64'],
      ['linux-x64', 'bun-linux-x64', 'corch-linux-x64'],
    ])
  })

  test("build this machine's platform by default, the ones named, or all four", () => {
    expect(chosen([])).toEqual(['darwin-arm64'])
    expect(chosen([], linux)).toEqual(['linux-x64'])
    expect(chosen(['--target', 'linux-x64', '--target=linux-arm64', '--target', 'linux-x64'])).toEqual([
      'linux-x64',
      'linux-arm64',
    ])
    expect(chosen(['--all'])).toEqual(PLATFORMS.map(platformKey))
  })

  test('refuse an unknown target with the supported ones, and a darwin target off macOS with the reason', () => {
    const supported = 'Supported targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64'
    expect(chosen(['--target', 'win32-x64'])).toContain(supported)
    expect(chosen([], { platform: 'linux', arch: 'ia32' })).toContain('Unsupported target linux-ia32')
    expect(chosen(['--target'])).toContain(supported)
    expect(chosen(['--target', 'darwin-x64'], linux)).toContain('darwin executables must be signed')
    expect(chosen(['--all'], linux)).toContain('only macOS can sign them')
  })

  test('compile with no .env or bunfig.toml autoload, for the target, with the version and commit as build id', () => {
    const target = PLATFORMS[2] as (typeof PLATFORMS)[number]
    const buildId = buildIdFor('1.2.3', 'abc1234', false)
    const args = compileArgs({ target, entry: '/e.ts', outfile: '/out/corch', buildId })
    expect(args.slice(0, 2)).toEqual(['build', '--compile'])
    expect(args).toContain('--no-compile-autoload-dotenv')
    expect(args).toContain('--no-compile-autoload-bunfig')
    expect(args).toContain('--target=bun-linux-arm64')
    expect(args).toContain('--define=ORCH_BUILD_ID="1.2.3+abc1234"')
    expect(args.slice(-3)).toEqual(['/e.ts', '--outfile', '/out/corch'])
    expect(buildIdFor('1.2.3', 'abc1234', true)).toBe('1.2.3+abc1234.dirty')
  })
})

describe('npm packages', () => {
  test('the launcher is the command, at the one version, with every platform package optional at it', () => {
    expect(template).toMatchObject({ name: 'corch', bin: { corch: 'bin/corch.js' }, engines: { node: '>=18' } })
    expect(template.scripts).toBeUndefined()
    expect(launcherManifest(template).optionalDependencies).toEqual({
      'corch-darwin-arm64': template.version,
      'corch-darwin-x64': template.version,
      'corch-linux-arm64': template.version,
      'corch-linux-x64': template.version,
    })
  })

  test('a platform package holds only its executable, for its own os and cpu, with no bin or scripts', () => {
    for (const target of PLATFORMS) {
      const manifest = platformManifest(target, template)
      expect(manifest).toMatchObject({
        name: target.npmName,
        version: template.version,
        os: [target.os],
        cpu: [target.arch],
        files: ['bin/corch'],
      })
      expect(manifest.bin).toBeUndefined()
      expect(manifest.scripts).toBeUndefined()
    }
  })
})
