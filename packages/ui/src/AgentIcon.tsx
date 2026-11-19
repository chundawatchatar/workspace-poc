import type { AgentKind } from '@orch/shared'
import { cn } from './lib/utils'

/**
 * How each agent kind is told apart in tabs and sidebar rows. `label` is its
 * short monogram, distinct from every other kind's, since several agents'
 * names start with the same letter.
 *
 * Every kind draws as a neutral monogram in a rounded square, not its vendor's
 * mark: no published permission to use a vendor's mark in a third-party tool
 * was found, and a look-alike of a logo is never drawn instead. Source and
 * licence per kind:
 * - `claude` (Claude Code): monogram, no vendor mark.
 * - `codex` (Codex): monogram, no vendor mark.
 * - `opencode` (OpenCode): monogram, no vendor mark.
 * - `cursor` (Cursor Agent): monogram, no vendor mark.
 * - `pi` (pi): monogram, no vendor mark.
 * - `commandcode` (Command Code): monogram, no vendor mark.
 * A vendor mark may replace a monogram only with the URL and licence of its
 * explicit permission recorded here; the `label` stays either way.
 */
export const AGENT_ICONS: Record<AgentKind, { label: string }> = {
  claude: { label: 'CC' },
  codex: { label: 'CX' },
  opencode: { label: 'OC' },
  cursor: { label: 'CU' },
  pi: { label: 'PI' },
  commandcode: { label: 'CM' },
}

/**
 * Draws which agent runs in a terminal, in the text colour around it. It is
 * decorative: the agent's name is in the tooltip or the row's text beside it.
 */
export function AgentIcon({ kind, size, className }: { kind: AgentKind; size: number; className?: string }) {
  const { label } = AGENT_ICONS[kind]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <rect x="0.6" y="0.6" width="14.8" height="14.8" rx="3.5" stroke="currentColor" strokeWidth="1.2" />
      <text
        x="8"
        y="8.6"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={label.length > 1 ? 8.5 : 11}
        fontWeight="800"
        letterSpacing="-0.5"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {label}
      </text>
    </svg>
  )
}
