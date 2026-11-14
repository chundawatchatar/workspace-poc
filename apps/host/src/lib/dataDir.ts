import { isAbsolute, join } from 'node:path'

/**
 * Where a packaged host keeps its files when nothing chooses a folder: `~/.corch` on macOS, and the XDG data folder
 * (`$XDG_DATA_HOME/corch`, or `~/.local/share/corch`) on Linux. A blank or relative `XDG_DATA_HOME` is ignored, as
 * the XDG spec asks. The dev host doesn't use it: it keeps `apps/host/.data/` (see `env.ts`).
 */
export function defaultDataDir(options: {
  platform: NodeJS.Platform
  home: string
  env: Record<string, string | undefined>
}): string {
  const { platform, home, env } = options
  if (platform === 'darwin') return join(home, '.corch')
  if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME?.trim()
    return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'corch')
  }
  throw new Error(`The host has no default data folder on ${platform}; it runs on macOS and Linux only`)
}
