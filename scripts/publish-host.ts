import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LauncherTemplate } from '../apps/host/packaging/platforms'
import { publishPlan, stepsToPublish, tarballIntegrity } from '../apps/host/packaging/release'

/**
 * `bun run release:publish <folder> [--dry-run]`: publishes the five `corch`
 * tarballs in a folder to npm, the four platform packages first and the
 * launcher last, at the launcher template's version. It refuses the folder
 * unless it holds exactly those five. Before publishing anything it asks the
 * registry for each version: one already there is skipped only when its
 * `dist.integrity` is this tarball's, so a re-run after a partial failure
 * finishes the release, and any other contents (an earlier build, or someone
 * else's package under the name) stop it with nothing published. The token
 * comes only from `NODE_AUTH_TOKEN`, through the `.npmrc`
 * that `actions/setup-node` writes; it is never an argument. `--dry-run` runs
 * `npm publish --dry-run` for every tarball instead, needs no token and asks
 * the registry nothing.
 */

const root = resolve(import.meta.dir, '..')

function fail(message: string): never {
  console.error(`release:publish: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const folders = args.filter((arg) => arg !== '--dry-run')
if (folders.length !== 1 || folders[0]?.startsWith('-')) fail('use release:publish <tarball folder> [--dry-run]')
const folder = resolve(folders[0] as string)

const { version } = JSON.parse(
  readFileSync(join(root, 'apps/host/packaging/npm/corch/package.json'), 'utf8'),
) as LauncherTemplate
const plan = publishPlan(readdirSync(folder), version)
if (!plan.ok) fail(plan.error)
if (!dryRun && !process.env.NODE_AUTH_TOKEN) fail('NODE_AUTH_TOKEN is not set')

/**
 * The `dist.integrity` the registry has for `name@version`: null when it has no such version, and empty when it has
 * one but gives no integrity. `npm view` fails with E404 for a missing package or version (older npm prints nothing
 * for a missing version); any other failure stops the release.
 */
function registryIntegrity(name: string): string | null {
  const view = Bun.spawnSync(['npm', 'view', `${name}@${version}`, 'version', 'dist.integrity', '--json'], {
    cwd: folder,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = view.stdout.toString().trim()
  if (view.exitCode === 0) {
    if (stdout === '') return null
    const found = JSON.parse(stdout) as { version?: string; 'dist.integrity'?: string }
    return found.version === version ? (found['dist.integrity'] ?? '') : null
  }
  const stderr = view.stderr.toString()
  if (stderr.includes('E404')) return null
  console.error(stderr)
  fail(`checking the registry for ${name}@${version} failed (exit ${view.exitCode})`)
}

console.log(`${dryRun ? 'Dry run: publishing' : 'Publishing'} corch ${version} with dist-tag ${plan.value.distTag}`)
let steps = plan.value.steps
if (!dryRun) {
  const integrity = Object.fromEntries(
    steps.map((step) => [step.file, tarballIntegrity(readFileSync(join(folder, step.file)))]),
  )
  const registry = Object.fromEntries(steps.map((step) => [step.name, registryIntegrity(step.name)]))
  const remaining = stepsToPublish(plan.value, integrity, registry)
  if (!remaining.ok) fail(remaining.error)
  for (const step of steps.filter((candidate) => !remaining.value.includes(candidate))) {
    console.log(`${step.name}@${version} is already on the registry with these exact contents; skipping it`)
  }
  steps = remaining.value
}
for (const step of steps) {
  const tarball = join(folder, step.file)
  const command = ['npm', 'publish', tarball, '--access', 'public', '--tag', plan.value.distTag, '--ignore-scripts']
  if (dryRun) command.push('--dry-run')
  const result = Bun.spawnSync(command, { cwd: folder, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) fail(`publishing ${step.file} failed (exit ${result.exitCode})`)
}
console.log(dryRun ? `Dry run of corch ${version} passed; nothing was published` : `Published corch ${version}`)
