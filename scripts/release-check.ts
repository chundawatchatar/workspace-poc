import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LauncherTemplate } from '../apps/host/packaging/platforms'
import { type PreflightMode, preflight } from '../apps/host/packaging/release'
import { SETTINGS_DEFAULTS } from '../apps/host/src/modules/settings/settings.service'

/**
 * `bun run release:check --tag <ref>` or `--dry-run`: the release
 * workflow's preflight, before anything is built. A tag run fails unless the
 * tag is `v<version>` for the launcher template's version and the built-in
 * relay address is a real `wss://` one. A dry run checks the same, but a
 * placeholder relay address is a warning there. Findings are GitHub
 * annotations.
 */

const root = resolve(import.meta.dir, '..')

function usage(): never {
  console.error('release:check: use --tag <ref> (refs/tags/v<version>) or --dry-run')
  process.exit(2)
}

const args = process.argv.slice(2)
let mode: PreflightMode
if (args.length === 1 && args[0] === '--dry-run') mode = { dryRun: true }
else if (args.length === 2 && args[0] === '--tag' && args[1]) mode = { tag: args[1] }
else usage()

const { version } = JSON.parse(
  readFileSync(join(root, 'apps/host/packaging/npm/corch/package.json'), 'utf8'),
) as LauncherTemplate
const report = preflight({ mode, templateVersion: version, relayUrl: SETTINGS_DEFAULTS.relayUrl })
for (const line of report.lines) console.log(line)
process.exit(report.ok ? 0 : 1)
