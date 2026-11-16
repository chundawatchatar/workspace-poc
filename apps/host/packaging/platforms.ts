// What `scripts/package-host.ts` builds: the platforms `corch` ships for, the compile command for each, and the npm
// packages it lays out. Everything here is pure, so the tests check it without compiling anything.

/** A platform `corch` ships a compiled executable for. */
export interface Platform {
  /** As Node's `process.platform` names it. */
  os: 'darwin' | 'linux'
  /** As Node's `process.arch` names it. */
  arch: 'arm64' | 'x64'
  /** Bun's `--target` for it. */
  bunTarget: string
  /** The npm package holding its executable, `corch-<os>-<arch>`. */
  npmName: string
}

function platform(os: Platform['os'], arch: Platform['arch']): Platform {
  return { os, arch, bunTarget: `bun-${os}-${arch}`, npmName: `corch-${os}-${arch}` }
}

/** The four platforms, as `<os>-<arch>` keys. Windows and Linux musl are not among them. */
export const PLATFORMS: readonly Platform[] = [
  platform('darwin', 'arm64'),
  platform('darwin', 'x64'),
  platform('linux', 'arm64'),
  platform('linux', 'x64'),
]

/** The `<os>-<arch>` key of a platform, as `--target` takes it. */
export const platformKey = (target: Pick<Platform, 'os' | 'arch'>) => `${target.os}-${target.arch}`

/** The file in `dist/package/build/` holding the SHA-256 of each UI file compiled into `target`'s executable. */
export const uiHashesName = (target: Platform) => `${target.npmName}.ui-files.json`

/** The launcher package's name, the one users install. */
export const LAUNCHER_NAME = 'corch'

/** What the arguments of `package:host` ask for: the platforms to build, or the reason they make none. */
export type TargetChoice = { ok: true; platforms: Platform[] } | { ok: false; error: string }

/**
 * Reads `package:host`'s arguments on a machine whose platform is `host` (`process.platform`, `process.arch`).
 * No argument builds the host's own platform; `--target <os>-<arch>`, repeatable, builds the ones named; `--all`
 * builds all four. A darwin executable must be signed, which only macOS can do, so a darwin target is refused
 * anywhere else. Every refusal comes before anything is built.
 */
export function chooseTargets(argv: string[], host: { platform: string; arch: string }): TargetChoice {
  const supported = `Supported targets: ${PLATFORMS.map(platformKey).join(', ')}`
  const keys: string[] = []
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--all') all = true
    else if (arg === '--target' && argv[i + 1] !== undefined) keys.push(argv[++i] as string)
    else if (arg.startsWith('--target=')) keys.push(arg.slice('--target='.length))
    else return { ok: false, error: `Unknown argument ${arg}. Use --target <os>-<arch> or --all. ${supported}` }
  }
  if (!all && keys.length === 0) keys.push(`${host.platform}-${host.arch}`)
  const chosen: Platform[] = []
  for (const key of all ? PLATFORMS.map(platformKey) : keys) {
    const found = PLATFORMS.find((candidate) => platformKey(candidate) === key)
    if (!found) return { ok: false, error: `Unsupported target ${key}. ${supported}` }
    if (!chosen.includes(found)) chosen.push(found)
  }
  const unsigned = chosen.find((target) => target.os === 'darwin')
  if (unsigned && host.platform !== 'darwin') {
    return {
      ok: false,
      error: `Cannot build ${platformKey(unsigned)} on ${host.platform}: darwin executables must be signed, and only macOS can sign them.`,
    }
  }
  return { ok: true, platforms: chosen }
}

/**
 * The build id compiled into every executable: the version and the git commit, with `.dirty` when the working tree
 * had changes. The daemon reports it, so a host can tell whether the daemon runs its code.
 */
export function buildIdFor(version: string, commit: string, dirty: boolean): string {
  return `${version}+${commit}${dirty ? '.dirty' : ''}`
}

/**
 * The arguments after `bun` that compile `entry` into one executable for `target`. A compiled executable would load
 * the working folder's `.env` and `bunfig.toml` by default, so a folder could set its variables or preload code into
 * it; both are turned off.
 */
export function compileArgs({
  target,
  entry,
  outfile,
  buildId,
}: {
  target: Platform
  entry: string
  outfile: string
  buildId: string
}): string[] {
  return [
    'build',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    `--target=${target.bunTarget}`,
    `--define=ORCH_BUILD_ID=${JSON.stringify(buildId)}`,
    entry,
    '--outfile',
    outfile,
  ]
}

/** The `package.json` fields the launcher template sets, which the build reads. */
export interface LauncherTemplate {
  name: string
  version: string
  [field: string]: unknown
}

/** The launcher's `package.json`: the template, with every platform package as an optional dependency of its version. */
export function launcherManifest(template: LauncherTemplate): Record<string, unknown> {
  return {
    ...template,
    optionalDependencies: Object.fromEntries(PLATFORMS.map((target) => [target.npmName, template.version])),
  }
}

/**
 * A platform package's `package.json`: only the executable, for npm to install on that platform alone. It has no
 * `bin`, since the launcher is the command, and no scripts.
 */
export function platformManifest(target: Platform, template: LauncherTemplate): Record<string, unknown> {
  return {
    name: target.npmName,
    version: template.version,
    description: `The corch executable for ${target.os === 'darwin' ? 'macOS' : 'Linux'} on ${target.arch}`,
    license: template.license,
    os: [target.os],
    cpu: [target.arch],
    files: ['bin/corch'],
  }
}

/**
 * The file beside this one holding the entitlements a Developer ID signature
 * gives `corch` under the hardened runtime: the JIT, unsigned executable
 * memory and no executable page protection, which Bun's JavaScript engine
 * needs to start. Bun's codesign guide also lists
 * `disable-library-validation` and `allow-dyld-environment-variables`; `corch`
 * loads no native addon and needs no `DYLD_*` variable, and either would let
 * other code load into a process that holds the machine key.
 */
export const ENTITLEMENTS_FILE = 'entitlements.plist'

/**
 * The arguments after `codesign` that sign a darwin executable. With no identity the signature is ad hoc, which is
 * enough to run on the machine that built it and in CI. With a Developer ID identity it is the one notarization
 * accepts: the hardened runtime, a secure timestamp and the committed entitlements, which let Bun's JavaScript engine
 * compile code at run time.
 */
export function codesignArgs({
  file,
  identity,
  entitlements,
}: {
  file: string
  identity: string | null
  entitlements: string
}): string[] {
  if (!identity) return ['--force', '--sign', '-', file]
  return ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--entitlements', entitlements, file]
}

/** The team id in a Developer ID identity such as `Developer ID Application: Name (ABCDE12345)`; null when it has none. */
export function identityTeam(identity: string): string | null {
  return identity.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1] ?? null
}

/**
 * What is wrong with a Developer ID signature, from what `codesign --display --verbose=2` writes about it: it must have
 * the hardened runtime, a secure timestamp and `team`'s id. Empty when it has all three. The problems never quote the
 * signature, so they name no identity.
 */
export function signatureProblems(display: string, team: string): string[] {
  const flags = display.match(/^CodeDirectory .*\bflags=0x[0-9a-f]+\(([^)]*)\)/m)?.[1]?.split(',') ?? []
  const problems: string[] = []
  if (!flags.includes('runtime')) problems.push('it has no hardened runtime')
  if (flags.includes('adhoc')) problems.push('it is ad hoc')
  if (!/^Timestamp=/m.test(display)) problems.push('it has no secure timestamp')
  if (display.match(/^TeamIdentifier=(.*)$/m)?.[1] !== team) problems.push("its team is not the identity's team")
  return problems
}
