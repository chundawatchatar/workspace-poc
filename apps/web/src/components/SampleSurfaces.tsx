import { CircleDot, GitMerge, GitPullRequest, MessageSquare } from 'lucide-react'
import type { ReactNode } from 'react'

// Placeholder views with hard-coded data. They show where git and issue
// tracking would sit beside the terminals; nothing here is connected.

function SampleShell(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
          Sample data
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  )
}

const PULLS = [
  {
    id: 42,
    title: 'Attach sessions over a single socket',
    branch: 'mux-socket',
    author: 'priya',
    checks: 'passing',
    comments: 4,
    state: 'open',
  },
  {
    id: 41,
    title: 'Restore pane layout after restart',
    branch: 'restore-layout',
    author: 'review-agent',
    checks: 'running',
    comments: 1,
    state: 'open',
  },
  {
    id: 39,
    title: 'Scope agent tokens to one repository',
    branch: 'scoped-tokens',
    author: 'tomas',
    checks: 'failing',
    comments: 7,
    state: 'open',
  },
  {
    id: 37,
    title: 'Add terminal runner type for workflows',
    branch: 'terminal-runner',
    author: 'priya',
    checks: 'passing',
    comments: 12,
    state: 'merged',
  },
] as const

const CHECK_STYLE = {
  passing: 'text-good',
  running: 'text-warn',
  failing: 'text-bad',
} as const

export function PullsView() {
  return (
    <SampleShell title="Pull requests">
      <ul>
        {PULLS.map((pull) => (
          <li key={pull.id} className="flex items-start gap-3 border-b border-line/60 px-4 py-3 hover:bg-raised/40">
            <span className={`mt-0.5 ${pull.state === 'merged' ? 'text-zoom' : 'text-good'}`}>
              {pull.state === 'merged' ? <GitMerge size={15} /> : <GitPullRequest size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{pull.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-dim">
                <span>#{pull.id}</span>
                <span className="rounded bg-raised px-1.5 font-mono text-[11px]">{pull.branch}</span>
                <span>by {pull.author}</span>
                <span className={CHECK_STYLE[pull.checks]}>checks {pull.checks}</span>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1 text-xs text-dim">
              <MessageSquare size={12} />
              {pull.comments}
            </span>
          </li>
        ))}
      </ul>
    </SampleShell>
  )
}

const COLUMNS = [
  {
    name: 'Ready',
    issues: [
      { key: 'APP-131', title: 'Copy mode for scrollback', label: 'terminal', who: 'TM' },
      { key: 'APP-128', title: 'Import a repository from a URL', label: 'git', who: 'PR' },
    ],
  },
  {
    name: 'In progress',
    issues: [
      { key: 'APP-126', title: 'Review agent on pull request opened', label: 'agents', who: 'AI' },
      { key: 'APP-124', title: 'Branch protection: required checks', label: 'git', who: 'PR' },
      { key: 'APP-119', title: 'Reconnect after network change', label: 'remote', who: 'TM' },
    ],
  },
  {
    name: 'In review',
    issues: [{ key: 'APP-117', title: 'Pair a device with a one-time code', label: 'remote', who: 'PR' }],
  },
]

export function IssuesView() {
  return (
    <SampleShell title="Issues">
      <div className="flex h-full min-w-max gap-3 p-3">
        {COLUMNS.map((column) => (
          <section key={column.name} className="flex w-56 flex-col rounded-md bg-bg/60 p-2">
            <header className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-dim">
              {column.name}
              <span className="text-faint">{column.issues.length}</span>
            </header>
            <div className="flex flex-col gap-2">
              {column.issues.map((issue) => (
                <article key={issue.key} className="rounded-md border border-line bg-raised p-2.5">
                  <div className="text-[13px] leading-snug">{issue.title}</div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-dim">
                    <CircleDot size={11} className="text-good" />
                    <span className="font-mono">{issue.key}</span>
                    <span className="rounded bg-accent/15 px-1.5 text-accent">{issue.label}</span>
                    <span className="ml-auto flex h-4.5 w-4.5 items-center justify-center rounded-full bg-line text-[9px] text-ink">
                      {issue.who}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SampleShell>
  )
}
