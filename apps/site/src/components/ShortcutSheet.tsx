import { Modal } from '@orch/ui'

/** `sidebar` marks a row that only applies where the page has a sidebar. */
const SITE_ROWS: { label: string; leader: string; direct: string; sidebar?: boolean }[] = [
  { label: 'Command palette', leader: '', direct: '⌘P  ·  Ctrl+Shift+P' },
  { label: 'Jump to section 1–7', leader: '1 – 7', direct: '' },
  { label: 'Choose theme', leader: 'T', direct: '' },
  { label: 'Toggle sidebar', leader: 'B', direct: '⌘B on Mac', sidebar: true },
  { label: 'Show shortcuts', leader: '?', direct: '' },
]

/**
 * The site's own shortcuts. They work like the app's: the same leader key, the same palette keys. Without `sidebar`,
 * on a page with no sidebar, the sidebar row is left out.
 */
export function ShortcutSheet(props: { leaderLabel: string; sidebar: boolean; onClose: () => void }) {
  const rows = SITE_ROWS.filter((row) => props.sidebar || !row.sidebar)
  return (
    <Modal title="Keyboard shortcuts" width="w-[520px] max-w-[94vw]" onClose={props.onClose}>
      <p className="mb-3 text-xs leading-relaxed text-dim">
        This site answers to the app's keys. Press <kbd>{props.leaderLabel}</kbd>, release, then the key in the first
        column.
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-faint">
            <th className="pb-1.5 font-medium">Action</th>
            <th className="pb-1.5 font-medium">After {props.leaderLabel}</th>
            <th className="pb-1.5 font-medium">Direct</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-line/60">
              <td className="py-1.5 pr-3">{row.label}</td>
              <td className="py-1.5 pr-3">{row.leader && <kbd>{row.leader}</kbd>}</td>
              <td className="py-1.5 text-dim">{row.direct}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-faint">
        The app has many more.{' '}
        <a className="text-accent underline underline-offset-2" href="/docs/keyboard-shortcuts">
          See every shortcut
        </a>
        .
      </p>
    </Modal>
  )
}
