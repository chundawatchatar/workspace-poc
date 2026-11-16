import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { collectUiFiles, embeddedEntrySource } from '../apps/host/packaging/embed-ui'
import {
  buildIdFor,
  chooseTargets,
  compileArgs,
  LAUNCHER_NAME,
  type LauncherTemplate,
  launcherManifest,
  type Platform,
  platformKey,
  platformManifest,
  uiHashesName,
} from '../apps/host/packaging/platforms'

/**
 * `bun run package:host`: compiles `corch` into one executable per platform,
 * with the host, the terminal daemon and the built local UI inside, and lays
 * out the npm packages users install: the `corch` launcher and one
 * `corch-<os>-<arch>` package per platform, each packed into
 * `dist/package/tarballs/`. It builds this machine's platform, or the ones
 * named with `--target <os>-<arch>` (repeatable) or `--all`. A darwin
 * executable is signed ad hoc and checked, so one is never shipped unsigned;
 * Bun's own darwin output is signed invalidly. The executables never read a
 * `.env` or `bunfig.toml`. Cross-compiling downloads Bun's runtime for the
 * target, so it needs the network.
 */

const root = resolve(import.meta.dir, '..')
const packaging = join(root, 'apps/host/packaging')
const out = join(root, 'dist/package')
const tarballs = join(out, 'tarballs')

function fail(message: string): never {
  console.error(`package:host: ${message}`)
  process.exit(1)
}

/** Runs a command with this terminal, failing the build with `what` when it exits non-zero. */
function run(what: string, command: string[], cwd = root) {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) fail(`${what} failed (exit ${result.exitCode})`)
}

/** A command's trimmed output, or the build fails with `what`. */
function output(what: string, command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'inherit' })
  if (result.exitCode !== 0) fail(`${what} failed (exit ${result.exitCode})`)
  return result.stdout.toString().trim()
}

const choice = chooseTargets(process.argv.slice(2), process)
if (!choice.ok) fail(choice.error)

const template = JSON.parse(readFileSync(join(packaging, 'npm/corch/package.json'), 'utf8')) as LauncherTemplate
const commit = output('reading the git commit', ['git', 'rev-parse', '--short', 'HEAD'])
const dirty = output('reading the git status', ['git', 'status', '--porcelain']) !== ''
const buildId = buildIdFor(template.version, commit, dirty)

console.log('Building the local UI (apps/web)')
run('building apps/web', [process.execPath, 'run', '--filter', '@orch/web', 'build'])
const uiFiles = collectUiFiles(join(root, 'apps/web/dist'))

// The generated entry embeds the UI and then runs the host's real entry point, `main.ts`.
mkdirSync(join(out, 'build'), { recursive: true })
const entry = join(out, 'build/corch-entry.ts')
writeFileSync(
  entry,
  embeddedEntrySource({
    files: uiFiles,
    registry: join(root, 'apps/host/src/cli/embedded-ui.ts'),
    main: join(root, 'apps/host/src/main.ts'),
  }),
)
// What each embedded file hashes to, written beside each executable built from them, so the smoke test can check that
// a compiled `corch` serves them byte for byte even after a later build of another platform.
const uiHashes = Object.fromEntries(
  Object.entries(uiFiles).map(([urlPath, path]) => [
    urlPath,
    new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex'),
  ]),
)

/** Empties `dir` and writes `manifest` as its `package.json`, with the repo's licence beside it. */
function layOut(dir: string, manifest: Record<string, unknown>) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
}

const npm = join(out, 'npm')
const launcherDir = join(npm, LAUNCHER_NAME)
layOut(launcherDir, launcherManifest(template))
copyFileSync(join(packaging, 'npm/corch/bin/corch.js'), join(launcherDir, 'bin/corch.js'))
chmodSync(join(launcherDir, 'bin/corch.js'), 0o755)

/** Compiles, signs where needed and lays out the package for `target`. Answers its folder. */
function buildPlatform(target: Platform): string {
  const dir = join(npm, target.npmName)
  layOut(dir, platformManifest(target, template))
  const outfile = join(dir, 'bin/corch')
  console.log(`\nCompiling ${platformKey(target)} (${buildId})`)
  run(`compiling ${platformKey(target)}`, [process.execPath, ...compileArgs({ target, entry, outfile, buildId })])
  chmodSync(outfile, 0o755)
  if (target.os === 'darwin') {
    run(`signing ${platformKey(target)}`, ['codesign', '--force', '--sign', '-', outfile])
    run(`checking the signature of ${platformKey(target)}`, ['codesign', '--verify', '--strict', outfile])
  }
  writeFileSync(join(out, 'build', uiHashesName(target)), `${JSON.stringify(uiHashes, null, 2)}\n`)
  return dir
}

const built = [launcherDir, ...choice.platforms.map(buildPlatform)]

mkdirSync(tarballs, { recursive: true })
const packed: string[] = []
for (const dir of built) {
  const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }
  // Any older tarball of the same package goes, so the folder holds one per package.
  const older = new RegExp(`^${name}-\\d.*\\.tgz$`)
  for (const file of readdirSync(tarballs)) if (older.test(file)) rmSync(join(tarballs, file))
  packed.push(output(`packing ${name}`, [process.execPath, 'pm', 'pack', '--quiet', '--destination', tarballs], dir))
}

console.log(`\nBuilt ${buildId} with Bun ${Bun.version}:`)
for (const dir of built) console.log(`  ${relative(root, dir)}/`)
for (const file of packed) console.log(`  ${relative(root, resolve(root, file))}`)
