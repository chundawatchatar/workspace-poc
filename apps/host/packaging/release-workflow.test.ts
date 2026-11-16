import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The release workflow's safety rules, checked on the file itself, since a pull request run can only prove the dry
// run works, not that a secret is out of its reach.

const path = join(import.meta.dir, '../../../.github/workflows/release.yml')
const text = readFileSync(path, 'utf8')

interface Step {
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  environment?: string
  permissions?: Record<string, string>
  steps: Step[]
}
const workflow = Bun.YAML.parse(text) as {
  on: Record<string, unknown>
  permissions: unknown
  env?: unknown
  concurrency: { group: string; 'cancel-in-progress': string }
  jobs: Record<string, Job>
}
const jobs = Object.entries(workflow.jobs)
const steps = jobs.flatMap(([, job]) => job.steps)

/** The expression that is true only for a pushed release tag. */
const TAG_RUN = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"

/** True when an `if` can only pass on a tag push: it requires `TAG_RUN` and has no `||` or `!` to get around it. */
function requiresTagRun(condition: string | undefined): boolean {
  if (condition === undefined) return false
  const expression = condition.replace(/^\$\{\{(.*)\}\}$/s, '$1')
  return expression.includes(TAG_RUN) && !expression.includes('||') && !/!(?!=)/.test(expression)
}

describe('release.yml', () => {
  test('releases on a pushed v* tag, dry-runs on a pull request or by hand, and never on pull_request_target', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ tags: ['v*'] })
  })

  test('only reads the repository, in every job', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const widened = jobs.flatMap(([name, job]) =>
      Object.entries(job.permissions ?? {})
        .filter(([scope, level]) => level !== 'none' && !(scope === 'contents' && level === 'read'))
        .map(([scope, level]) => `${name} ${scope}: ${level}`),
    )
    expect(widened).toEqual([])
  })

  test('pins every action to a commit, with its tag beside it', () => {
    const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []))
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    const lines = text.split('\n').filter((line) => /^\s*(- )?uses:/.test(line))
    expect(lines).toHaveLength(uses.length)
    for (const line of lines) expect(line).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/)
  })

  test('checks out without credentials, on Bun 1.4.0, installing from the lockfile', () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(jobs.length)
    for (const step of checkouts) expect(step.with?.['persist-credentials']).toBe(false)
    const bun = steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'))
    expect(bun).toHaveLength(jobs.length)
    for (const step of bun) expect(String(step.with?.['bun-version'])).toBe('1.4.0')
    const installs = steps.filter((step) => /\bbun (install|i)\b/.test(step.run ?? ''))
    expect(installs.length).toBeGreaterThan(0)
    for (const step of installs) expect(step.run).toContain('bun install --frozen-lockfile')
  })

  test('reaches a secret only in a tag run, in a job whose environment is release only then', () => {
    const releaseOnTags = `\${{ (${TAG_RUN}) && 'release' || '' }}`
    expect(JSON.stringify(workflow.env ?? {})).not.toContain('secrets.')
    const reachable: string[] = []
    let secretSteps = 0
    for (const [name, job] of jobs) {
      const { steps: jobSteps, ...rest } = job
      if (JSON.stringify(rest).includes('secrets.')) reachable.push(`${name}: outside a step`)
      if (job.environment !== undefined && job.environment !== releaseOnTags) reachable.push(`${name}: environment`)
      for (const step of jobSteps.filter((candidate) => JSON.stringify(candidate).includes('secrets.'))) {
        secretSteps++
        if (!requiresTagRun(step.if) && !requiresTagRun(job.if)) reachable.push(`${name}: step if ${step.if}`)
        if (job.environment !== releaseOnTags) reachable.push(`${name}: a secret outside the release environment`)
      }
    }
    expect(reachable).toEqual([])
    // The signing certificate, the identity, the notary key and the npm token.
    expect(secretSteps).toBe(4)
    expect(text).not.toContain('pull_request_target')
    expect(text).not.toContain('secrets: inherit')
  })

  test('cancels an older dry run, never a tag run', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(`\${{ !(${TAG_RUN}) }}`)
    expect(workflow.concurrency.group).toStartWith(`\${{ (${TAG_RUN}) && format('release-{0}', github.run_id) || `)
  })
})
