import { Copy } from '@orch/ui/icons'
import { copyText } from '../lib/toast'

/** A shell command in a prompt-styled box, copied with one click. */
export function CopyCommand({ command }: { command: string }) {
  return (
    <div className="flex w-full max-w-full items-center gap-2 rounded-md border border-line bg-panel py-1.5 pr-1.5 pl-3 font-mono text-[13px]">
      <span className="shrink-0 text-good" aria-hidden="true">
        ❯
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-ink">{command}</code>
      <button
        type="button"
        onClick={() => copyText(command, 'Install command copied')}
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-sans text-xs text-dim hover:bg-raised hover:text-ink"
      >
        <Copy size={13} />
        Copy
      </button>
    </div>
  )
}
