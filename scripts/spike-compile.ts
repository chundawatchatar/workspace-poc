import { mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Builds the host and the terminal daemon as standalone executables for this platform, for the packaging spike
// (`docs/packaging-spike.md`). It only builds: running them outside the repo is the manual step the document
// describes, so a binary that misbehaves at runtime never fails this script. It reads no settings and no `.env`.

const root = resolve(import.meta.dir, '..')
const outDir = join(root, 'dist', 'spike')

/** The entry points to compile, and the name of each executable. */
const targets = [
  { name: 'orch-host', entry: 'apps/host/src/index.ts' },
  { name: 'orch-ptyd', entry: 'apps/ptyd-bun/src/main.ts' },
]

mkdirSync(outDir, { recursive: true })

const built: string[] = []
for (const { name, entry } of targets) {
  const outfile = join(outDir, name)
  // Bun's defaults are kept on purpose, including the `.env` and `bunfig.toml` autoload, so the spike records what
  // a plain `--compile` does. The packaging job chooses the flags.
  const build = Bun.spawn([process.execPath, 'build', '--compile', entry, '--outfile', outfile], {
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

console.log(`\nBuilt ${built.length} executables for ${process.platform}-${process.arch} with Bun ${Bun.version}:`)
for (const file of built) console.log(`  ${relative(process.cwd(), file) || file}`)
