import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LauncherTemplate } from '../apps/host/packaging/platforms'
import { publishPlan } from '../apps/host/packaging/release'

/**
 * `bun run release:publish <folder> [--dry-run]`: publishes the five `corch`
 * tarballs in a folder to npm, the four platform packages first and the
 * launcher last, at the launcher template's version. It refuses the folder
 * unless it holds exactly those five. A package whose version is already on
 * the registry is skipped, so a re-run after a partial failure finishes the
 * release. The token comes only from `NODE_AUTH_TOKEN`, through the `.npmrc`
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
 * True when `name@version` is on the registry. `npm view` prints nothing for a version the package doesn't have, and
 * fails with E404 for a package that doesn't exist yet; any other failure stops the release.
 */
function published(name: string): boolean {
  const view = Bun.spawnSync(['npm', 'view', `${name}@${version}`, 'version'], {
    cwd: folder,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (view.exitCode === 0) return view.stdout.toString().trim() !== ''
  const stderr = view.stderr.toString()
  if (stderr.includes('E404')) return false
  console.error(stderr)
  fail(`checking the registry for ${name}@${version} failed (exit ${view.exitCode})`)
}

console.log(`${dryRun ? 'Dry run: publishing' : 'Publishing'} corch ${version} with dist-tag ${plan.value.distTag}`)
for (const step of plan.value.steps) {
  if (!dryRun && published(step.name)) {
    console.log(`${step.name}@${version} is already on the registry; skipping it`)
    continue
  }
  const tarball = join(folder, step.file)
  const command = ['npm', 'publish', tarball, '--access', 'public', '--tag', plan.value.distTag, '--ignore-scripts']
  if (dryRun) command.push('--dry-run')
  const result = Bun.spawnSync(command, { cwd: folder, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) fail(`publishing ${step.file} failed (exit ${result.exitCode})`)
}
console.log(dryRun ? `Dry run of corch ${version} passed; nothing was published` : `Published corch ${version}`)
