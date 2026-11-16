import { isAbsolute, join } from 'node:path'
import { LOCK_HELD_EXIT } from './lifecycle'
import type { ManagerContext, ServiceManager } from './service'

// The Linux service: a unit of the systemd user manager, which runs while the user is logged in, or always when the
// user lingers.

/**
 * One `ExecStart` argument in systemd's quoting: in double quotes, with `\` and `"` escaped and control characters
 * written as `\xNN`, and with `%` written as `%%` and `$` as `$$`, so systemd expands no specifier or variable in it.
 */
export function systemdQuote(arg: string): string {
  const escaped = arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point.
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$')
  return `"${escaped}"`
}

/**
 * The user unit. A stop (SIGTERM, exit 0) is not restarted; a crash or a kill is, but not a `run` that found the
 * lock held. systemd signals only the host's own pid when it stops it, so the terminal daemon and its shells, which
 * stay in the unit's cgroup, outlive any host. No environment is set: the host reads its settings from the data
 * folder's `config.json`.
 */
export function systemdUnit(options: { programArguments: string[]; dataDir: string }): string {
  return `[Unit]
Description=corch terminal host

[Service]
Type=simple
ExecStart=${options.programArguments.map(systemdQuote).join(' ')}
Restart=on-failure
RestartPreventExitStatus=${LOCK_HELD_EXIT}
KillMode=process

[Install]
WantedBy=default.target
`
}

/**
 * The service as a systemd user unit, in `${XDG_CONFIG_HOME:-~/.config}/systemd/user` unless the context names a
 * folder. A blank or relative `XDG_CONFIG_HOME` is ignored, as the XDG spec asks.
 */
export function systemdService(context: ManagerContext): ServiceManager {
  const { call, run } = context
  const unit = `${context.name}.service`
  const xdg = context.env.XDG_CONFIG_HOME?.trim()
  const config = xdg && isAbsolute(xdg) ? xdg : join(context.home, '.config')
  const unitPath = join(context.unitDir ?? join(config, 'systemd', 'user'), unit)
  const systemctl = (...args: string[]) => call(['systemctl', '--user', ...args])
  const runtime = context.runtime ? ['--runtime'] : []

  return {
    name: unit,
    unitPath,
    unitText: systemdUnit({ programArguments: context.programArguments, dataDir: context.dataDir }),
    rawOutput: `journalctl --user -u ${unit}`,
    load: async () => (await systemctl('daemon-reload')) ?? systemctl('enable', '--now', ...runtime, unit),
    unload: () => systemctl('disable', '--now', ...runtime, unit),
    afterRemove: () => systemctl('daemon-reload'),
    start: () => systemctl('start', unit),
    stop: () => systemctl('stop', unit),
    restart: () => systemctl('restart', unit),
    async state() {
      const answer = (await run(['systemctl', '--user', 'is-active', unit])).out.trim()
      return answer || 'unknown'
    },
    async loginHint() {
      const answer = await run(['loginctl', 'show-user', context.user, '-p', 'Linger'])
      if (/^Linger=yes$/m.test(answer.out)) return null
      return [
        'The systemd user manager stops when you log out, and the host and its shells with it.',
        `To keep them running, run: loginctl enable-linger ${context.user}`,
      ].join('\n')
    },
  }
}
