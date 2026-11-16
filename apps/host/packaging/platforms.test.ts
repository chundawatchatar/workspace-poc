import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildIdFor,
  chooseTargets,
  codesignArgs,
  compileArgs,
  ENTITLEMENTS_FILE,
  identityTeam,
  type LauncherTemplate,
  launcherManifest,
  PLATFORMS,
  platformKey,
  platformManifest,
  signatureProblems,
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

describe('darwin signing', () => {
  const entitlements = join(import.meta.dir, ENTITLEMENTS_FILE)
  const identity = 'Developer ID Application: Example Ltd (ABCDE12345)'

  test('is ad hoc without an identity, and a hardened, timestamped Developer ID signature with one', () => {
    expect(codesignArgs({ file: '/b/corch', identity: null, entitlements })).toEqual([
      '--force',
      '--sign',
      '-',
      '/b/corch',
    ])
    expect(codesignArgs({ file: '/b/corch', identity: '', entitlements })).toEqual([
      '--force',
      '--sign',
      '-',
      '/b/corch',
    ])
    expect(codesignArgs({ file: '/b/corch', identity, entitlements })).toEqual([
      '--force',
      '--sign',
      identity,
      '--options',
      'runtime',
      '--timestamp',
      '--entitlements',
      entitlements,
      '/b/corch',
    ])
    expect(existsSync(entitlements)).toBe(true)
  })

  test('grant the JIT entitlements only', () => {
    const keys = [...readFileSync(entitlements, 'utf8').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])
    expect(keys.sort()).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-executable-page-protection',
    ])
  })

  test("are checked for the hardened runtime, a timestamp and the identity's team", () => {
    expect(identityTeam(identity)).toBe('ABCDE12345')
    expect(identityTeam('Developer ID Application: Example Ltd')).toBeNull()
    const display = [
      'Executable=/b/corch',
      'CodeDirectory v=20500 size=124207 flags=0x10000(runtime) hashes=3871+7 location=embedded',
      `Authority=${identity}`,
      'Timestamp=16 Nov 2026 at 10:00:00',
      'TeamIdentifier=ABCDE12345',
    ].join('\n')
    expect(signatureProblems(display, 'ABCDE12345')).toEqual([])
    const adHoc =
      'CodeDirectory v=20500 size=129360 flags=0x2(adhoc) hashes=4031+7 location=embedded\nTeamIdentifier=not set'
    expect(signatureProblems(adHoc, 'ABCDE12345')).toEqual([
      'it has no hardened runtime',
      'it is ad hoc',
      'it has no secure timestamp',
      "its team is not the identity's team",
    ])
  })
})
