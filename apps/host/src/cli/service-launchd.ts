import { join } from 'node:path'
import type { ManagerContext, ServiceManager } from './service'

// The macOS service: a per-user launchd agent in the `gui/<uid>` domain, which exists while the user is logged in.

/** The raw output file, for what the host prints before its own log writer starts. */
export const SERVICE_LOG = 'corch.service.log'

/** The launchd label for a service name: `corch.host` for `corch`, `corch.host.<hash>` for `corch-<hash>`. */
export function launchdLabel(name: string): string {
  return name === 'corch' ? 'corch.host' : `corch.host.${name.slice('corch-'.length)}`
}

const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const string = (text: string) => `<string>${escapeXml(text)}</string>`

/**
 * The agent's property list. A stop (SIGTERM, exit 0) is not relaunched; a crash or a kill is. launchd leaves the
 * job's process group alone when the job ends, so the terminal daemon and its shells outlive any host. No
 * environment is set: the host reads its settings from the data folder's `config.json`.
 */
export function launchdPlist(options: { label: string; programArguments: string[]; dataDir: string }): string {
  const { label, programArguments, dataDir } = options
  const output = string(join(dataDir, SERVICE_LOG))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(label)}
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    ${string(arg)}`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  ${output}
  <key>StandardErrorPath</key>
  ${output}
</dict>
</plist>
`
}

/** How long `install` waits for launchd to unload the job it replaces. */
const UNLOAD_TIMEOUT_MS = 10_000

/** The service as a launchd agent, with its plist in `~/Library/LaunchAgents` unless the context names a folder. */
export function launchdService(context: ManagerContext): ServiceManager {
  const { uid, call, run } = context
  const label = launchdLabel(context.name)
  const unitPath = join(context.unitDir ?? join(context.home, 'Library', 'LaunchAgents'), `${label}.plist`)
  const domain = `gui/${uid}`
  const target = `${domain}/${label}`
  const loaded = async () => (await run(['launchctl', 'print', target])).code === 0
  const bootstrap = () => call(['launchctl', 'bootstrap', domain, unitPath])

  return {
    name: label,
    unitPath,
    unitText: launchdPlist({ label, programArguments: context.programArguments, dataDir: context.dataDir }),
    rawOutput: join(context.dataDir, SERVICE_LOG),
    load: bootstrap,
    async unload() {
      if (!(await loaded())) return null
      const failed = await call(['launchctl', 'bootout', target])
      if (failed) return failed
      // `bootout` can return before the job is gone, and `bootstrap` refuses a label that is still loaded.
      const deadline = Date.now() + UNLOAD_TIMEOUT_MS
      while ((await loaded()) && Date.now() < deadline) await Bun.sleep(100)
      return null
    },
    afterRemove: async () => null,
    start: async () => ((await loaded()) ? call(['launchctl', 'kickstart', target]) : bootstrap()),
    stop: () => call(['launchctl', 'kill', 'SIGTERM', target]),
    restart: async () => ((await loaded()) ? call(['launchctl', 'kickstart', '-k', target]) : bootstrap()),
    async state() {
      const printed = await run(['launchctl', 'print', target])
      if (printed.code !== 0) return 'not loaded'
      const state = /^\s*state = (.+)$/m.exec(printed.out)?.[1]?.trim()
      return state ? `loaded, ${state}` : 'loaded'
    },
    loginHint: async () => null,
  }
}
