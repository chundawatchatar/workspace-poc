import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const backend = process.argv[2]
if (backend !== 'memory' && backend !== 'bun') {
  console.error('Usage: bun scripts/set-terminal-backend.ts bun|memory')
  process.exit(1)
}
const root = resolve(import.meta.dir, '..')
const folder = join(root, 'apps/host/.data')
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, 'terminal-backend.json'), JSON.stringify({ backend }), { mode: 0o600 })
// Bun watches source files; changing the setting must also reload an already running dev host.
const entry = join(root, 'apps/host/src/index.ts')
writeFileSync(entry, readFileSync(entry))
console.log(`Terminal backend set to ${backend}. A dev host reloads automatically; otherwise restart it.`)
