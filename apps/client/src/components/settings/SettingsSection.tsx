import type { ReactNode } from 'react'

/** A settings page's title, at the top of the content column. */
export function SettingsTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-xl font-semibold text-ink">{children}</h1>
}

/** A titled group on a settings page, with an optional description under the title and an action at its end. */
export function SettingsSection(props: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-ink">{props.title}</h2>
          {props.description && <p className="text-dim">{props.description}</p>}
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

/** A bordered card of `SettingsRow`s, divided by lines. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-panel px-4">{children}</div>
  )
}

/** One setting: its label (and an optional description) on the left, its value or control on the right. */
export function SettingsRow(props: { label: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ink">{props.label}</span>
        {props.description && <span className="text-xs text-dim">{props.description}</span>}
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-2 text-dim">{props.children}</div>
    </div>
  )
}

/** A settings page that has no settings yet. */
export function ComingSoonSettings({ title }: { title: string }) {
  return (
    <>
      <SettingsTitle>{title}</SettingsTitle>
      <SettingsCard>
        <p className="py-6 text-center text-dim">Nothing to set here yet.</p>
      </SettingsCard>
    </>
  )
}
