import { mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Builds the host as one standalone executable for this platform, for the packaging spike
// (`docs/packaging-spike.md`). The terminal daemon is the same executable, run with the host's daemon subcommand.
// It only builds: running it outside the repo is the manual step the document describes, so a binary that
// misbehaves at runtime never fails this script. It reads no settings and no `.env`, and neither does the binary.

const root = resolve(import.meta.dir, '..')
const outDir = join(root, 'dist', 'spike')

// The build id names the code a daemon runs. It is compiled in with `--define`, since the source files a host run
// from source hashes are not in an executable; the packaging job passes its own id the same way.
const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim()
if (!sha) {
  console.error('spike:compile: could not read the git commit for the build id')
  process.exit(1)
}
const buildId = `spike-${sha}`

/** The entry points to compile, and the name of each executable. */
const targets = [{ name: 'orch-host', entry: 'apps/host/src/main.ts' }]

mkdirSync(outDir, { recursive: true })

const built: string[] = []
for (const { name, entry } of targets) {
  const outfile = join(outDir, name)
  // A compiled executable loads the working folder's `.env` and `bunfig.toml` by default (finding 10), so a folder
  // could set the host's variables or preload code into it. Both are turned off, as the build job will.
  const args = [
    'build',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    entry,
    '--outfile',
    outfile,
    '--define',
    `ORCH_BUILD_ID=${JSON.stringify(buildId)}`,
  ]
  const build = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await build.exited
  if (code !== 0) {
    console.error(`spike:compile: building ${entry} failed (exit ${code})`)
    process.exit(code)
  }
  built.push(outfile)
}

console.log(
  `\nBuilt ${built.length} executable(s) for ${process.platform}-${process.arch} with Bun ${Bun.version}, ` +
    `build ${buildId}:`,
)
for (const file of built) console.log(`  ${relative(process.cwd(), file) || file}`)
