import { History, SquareTerminal } from './icons'

interface Props {
  /** The agent's name, such as `Claude Code`. */
  agent: string
  /** Its conversation id, or null when there is none to resume. */
  sessionId: string | null
  /** Where it ran, already shortened for display. */
  cwd: string
  /** The command the resume button runs. */
  command: string
  onResume: () => void
  onShell: () => void
}

/**
 * Covers a terminal whose agent was lost when the terminal daemon restarted,
 * and offers to start it again on the same conversation or open a plain shell.
 */
export function TerminalInterrupted({ agent, sessionId, cwd, command, onResume, onShell }: Props) {
  return (
    <div className="anim-fade absolute inset-0 z-10 flex items-center justify-center bg-panel/80 p-4">
      <div className="w-[380px] max-w-full rounded-lg border border-line bg-sidebar p-4 shadow-xl">
        <p className="text-sm font-medium">{agent} was interrupted</p>
        <p className="mt-1 text-xs text-dim">
          The terminal daemon restarted while it was running in <span className="font-mono">{cwd}</span>.
        </p>
        <p className="mt-1 break-all text-xs text-faint">
          Runs <span className="font-mono">{command}</span>
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent"
            onClick={onResume}
          >
            <History size={13} />
            {sessionId ? 'Resume' : 'Restart'} {agent}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-dim hover:bg-raised"
            onClick={onShell}
          >
            <SquareTerminal size={13} />
            Open shell
          </button>
        </div>
      </div>
    </div>
  )
}
