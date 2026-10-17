import type { GitInfo } from '@orch/shared'
import { expandDir } from '../fs/fs.service'

/** Runs git in `cwd` and returns its stdout, or null if git failed (for example, outside a repository). */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? out : null
}

/** The branch and number of changed files in a folder. Empty for a missing folder or one outside a repository. */
export async function getGitStatus(path: string): Promise<GitInfo> {
  const empty = { branch: null, changes: 0 }
  const cwd = expandDir(path)
  if (!cwd) return empty
  const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null
  if (!branch) return empty
  const status = (await runGit(cwd, ['status', '--porcelain'])) ?? ''
  return { branch, changes: status.split('\n').filter(Boolean).length }
}
