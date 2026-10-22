import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type AppState, makeWorkspace } from '@orch/shared'

function seed(projectRoot: string): AppState {
  // The sample pull request and issue tabs are disabled for now, so the first workspace starts with a terminal only.
  const project = makeWorkspace(basename(projectRoot), projectRoot)
  return { rev: 1, workspaces: [project, makeWorkspace('home', homedir())] }
}

/** The layout, kept in memory and written to a JSON file so it survives a restart. */
export class LayoutRepository {
  state: AppState
  /** Where the starting layout came from. An `invalid` file was replaced by the seed and says nothing about what existed. */
  readonly origin: 'file' | 'missing' | 'invalid'
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly file: string,
    projectRoot: string,
  ) {
    const loaded = this.load()
    this.origin = loaded === 'missing' || loaded === 'invalid' ? loaded : 'file'
    this.state = typeof loaded === 'object' ? loaded : seed(projectRoot)
  }

  private load(): AppState | 'missing' | 'invalid' {
    try {
      if (!existsSync(this.file)) return 'missing'
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AppState
      return Array.isArray(parsed.workspaces) ? parsed : 'invalid'
    } catch {
      return 'invalid'
    }
  }

  set(next: AppState) {
    this.state = { ...next, rev: this.state.rev + 1 }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }
}

export function dataFile(hostRoot: string) {
  return join(hostRoot, '.data', 'state.json')
}
