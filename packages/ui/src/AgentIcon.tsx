import type { AgentKind } from '@orch/shared'
import { cn } from './lib/utils'

/** One shape of a vendor's mark, with its path data exactly as in the vendor's file. */
type MarkPath = { d: string; fill?: string; fillRule?: 'evenodd'; clipRule?: 'evenodd' }

/** A vendor's official mark, and where its use in a third-party tool is permitted. */
export type AgentMark = {
  /** The `viewBox` of the vendor's file. */
  viewBox: string
  paths: readonly MarkPath[]
  /**
   * `currentColor` draws a one-colour mark in the text colour around it;
   * `fixed` keeps each path's own colours, for a vendor that forbids recolouring.
   */
  colors: 'currentColor' | 'fixed'
  /** Space left on each side inside the 16-unit icon box, so the mark looks as big as a monogram. */
  inset: number
  /** The URL of the asset the paths come from. */
  source: string
  /** The URL of the brand page or licence that permits the use. */
  terms: string
  /** What `terms` permits, in one line. */
  permits: string
}

/**
 * How each agent kind is told apart in tabs and sidebar rows. `label` is its
 * short monogram, distinct from every other kind's, since several agents'
 * names start with the same letter. A kind with a `mark` draws its vendor's
 * official mark instead; the `label` stays as the fallback.
 *
 * A vendor's mark is used only when its own published brand page or licence
 * permits this kind of third-party use, following every size and colour rule
 * there; a look-alike, simplified or redrawn logo is never drawn. Pages read
 * on 2026-11-19. Decision per kind:
 * - `claude` (Claude Code): monogram. Anthropic's trademark guidelines
 *   (https://www.anthropic.com/legal/trademark-guidelines) allow its marks only
 *   in materials it approves beforehand.
 * - `codex` (Codex): monogram. https://openai.com/brand refuses scripted
 *   fetches, so no permission could be read, and the `openai/codex` repo's
 *   Apache-2.0 licence grants no trademark rights.
 * - `opencode` (OpenCode): monogram. https://opencode.ai/brand sets a 16x20 px
 *   minimum for the bare logo, larger than the 13 px and 10 px slots here.
 * - `cursor` (Cursor Agent): official 2D cube, in the text colour.
 * - `pi` (pi): official badge mark, in the text colour.
 * - `commandcode` (Command Code): official logomark, in its fixed colours.
 * The marks' sources and terms are in their entries below.
 */
export const AGENT_ICONS: Record<AgentKind, { label: string; mark?: AgentMark }> = {
  claude: { label: 'CC' },
  codex: { label: 'CX' },
  opencode: { label: 'OC' },
  cursor: {
    label: 'CU',
    mark: {
      viewBox: '0 0 466.73 532.09',
      paths: [
        {
          d: 'M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z',
        },
      ],
      colors: 'currentColor',
      inset: 0,
      source:
        'https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip#General%20Logos/Cube/SVG/CUBE_2D_LIGHT.svg',
      terms: 'https://cursor.com/brand',
      permits:
        'Brand guidelines with downloadable logos "to represent Cursor consistently and accurately", no stated restrictions; the cube ships in one colour, dark or light.',
    },
  },
  pi: {
    label: 'PI',
    mark: {
      viewBox: '0 0 560 560',
      paths: [
        { d: 'M420 280H280V140H0V0H420V280Z' },
        { d: 'M560 560H420V280H560V560Z' },
        { d: 'M140 560H0V140H140V280H280V420H140V560Z' },
      ],
      colors: 'currentColor',
      inset: 1,
      source: 'https://pi.dev/favicon.svg',
      terms: 'https://pi.dev/press-kit',
      permits:
        'Press kit badge, a "square mark for favicons and compact badges", on a site marked MIT License; one colour, dark or light.',
    },
  },
  commandcode: {
    label: 'CM',
    mark: {
      viewBox: '0 0 137 137',
      paths: [
        {
          d: 'm0 66.7959c0-31.4879 0-47.2318 9.78204-57.01386 9.78206-9.78204 25.52596-9.78204 57.01396-9.78204h2.5357c31.4883 0 47.2323 0 57.0143 9.78204 9.782 9.78206 9.782 25.52596 9.782 57.01396v2.5357c0 31.4883 0 47.2323-9.782 57.0143s-25.526 9.782-57.0144 9.782h-2.5357c-31.4879 0-47.2318 0-57.01386-9.782-9.78204-9.782-9.78204-25.526-9.78204-57.0144z',
          fill: '#000',
        },
        {
          d: 'm69.3317 5.56633h-2.5357c-15.9014 0-27.2674.01182-35.905 1.17312-8.4775 1.13977-13.4886 3.29415-17.173 6.97855s-5.83878 8.6955-6.97855 17.173c-1.1613 8.6376-1.17312 20.0036-1.17312 35.9049v2.5357c0 15.9014.01182 27.2674 1.17312 35.9054 1.13977 8.477 3.29415 13.488 6.97855 17.173 3.6844 3.684 8.6955 5.838 17.173 6.978 8.6376 1.161 20.0036 1.173 35.9049 1.173h2.5357c15.9014 0 27.2674-.012 35.9054-1.173 8.477-1.14 13.488-3.294 17.173-6.978 3.684-3.685 5.838-8.696 6.978-17.173 1.161-8.638 1.173-20.004 1.173-35.9053v-2.5357c0-15.9014-.012-27.2674-1.173-35.905-1.14-8.4775-3.294-13.4886-6.978-17.173-3.685-3.6844-8.696-5.83878-17.173-6.97855-8.638-1.1613-20.004-1.17312-35.9053-1.17312zm-59.54966 4.21571c-9.78204 9.78206-9.78204 25.52596-9.78204 57.01386v2.5357c0 31.4884 0 47.2324 9.78204 57.0144 9.78206 9.782 25.52596 9.782 57.01386 9.782h2.5357c31.4884 0 47.2324 0 57.0144-9.782s9.782-25.526 9.782-57.0143v-2.5357c0-31.488 0-47.2319-9.782-57.01396-9.782-9.78204-25.526-9.78204-57.0143-9.78204h-2.5357c-31.488 0-47.2319 0-57.01396 9.78204z',
          fill: '#fff',
          fillRule: 'evenodd',
          clipRule: 'evenodd',
        },
        {
          d: 'm93.6604 26.1784c-8.982 0-16.2887 7.3067-16.2887 16.2888v6.9809h-18.6158v-6.9809c0-8.9821-7.3067-16.2888-16.2887-16.2888-8.9821 0-16.2888 7.3067-16.2888 16.2888s7.3067 16.2887 16.2888 16.2887h6.9809v18.6158h-6.9809c-8.9821 0-16.2888 7.3067-16.2888 16.2888 0 8.9825 7.3067 16.2885 16.2888 16.2885 8.982 0 16.2887-7.306 16.2887-16.2885v-6.981h18.6158v6.981c0 8.9825 7.3067 16.2885 16.2887 16.2885 8.9826 0 16.2886-7.306 16.2886-16.2885 0-8.9821-7.306-16.2888-16.2886-16.2888h-6.9809v-18.6158h6.9809c8.9826 0 16.2886-7.3066 16.2886-16.2887s-7.306-16.2888-16.2886-16.2888zm-6.9809 23.2697v-6.9809c0-3.8628 3.1182-6.9809 6.9809-6.9809 3.8628 0 6.9806 3.1181 6.9806 6.9809 0 3.8627-3.1178 6.9809-6.9806 6.9809zm-44.2123 0c-3.8628 0-6.9809-3.1182-6.9809-6.9809 0-3.8628 3.1181-6.9809 6.9809-6.9809 3.8627 0 6.9809 3.1181 6.9809 6.9809v6.9809zm16.2887 27.9236v-18.6158h18.6158v18.6158zm34.9045 23.2693c-3.8627 0-6.9809-3.1178-6.9809-6.9805v-6.981h6.9809c3.8628 0 6.9806 3.1182 6.9806 6.981 0 3.8627-3.1178 6.9805-6.9806 6.9805zm-51.1932 0c-3.8628 0-6.9809-3.1178-6.9809-6.9805 0-3.8628 3.1181-6.981 6.9809-6.981h6.9809v6.981c0 3.8627-3.1182 6.9805-6.9809 6.9805z',
          fill: '#fff',
        },
      ],
      colors: 'fixed',
      inset: 0,
      source:
        'https://raw.githubusercontent.com/CommandCodeAI/command-code/refs/heads/main/.github/commandcode/symbols/symbol.svg',
      terms: 'https://commandcode.ai/brand',
      permits:
        'Brand resources "when referencing Command Code in your projects"; the logomark is for "compact brand representations", and its colours are fixed.',
    },
  },
}

/**
 * Draws which agent runs in a terminal: its vendor's mark where one is
 * permitted, otherwise its monogram in the text colour around it. It is
 * decorative: the agent's name is in the tooltip or the row's text beside it.
 */
export function AgentIcon({ kind, size, className }: { kind: AgentKind; size: number; className?: string }) {
  const { label, mark } = AGENT_ICONS[kind]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-agent={kind}
      className={cn('shrink-0', className)}
    >
      {mark ? <Mark mark={mark} /> : <Monogram label={label} />}
    </svg>
  )
}

function Mark({ mark }: { mark: AgentMark }) {
  const box = 16 - 2 * mark.inset
  return (
    <svg
      x={mark.inset}
      y={mark.inset}
      width={box}
      height={box}
      viewBox={mark.viewBox}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {mark.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          fill={mark.colors === 'currentColor' ? 'currentColor' : path.fill}
          fillRule={path.fillRule}
          clipRule={path.clipRule}
        />
      ))}
    </svg>
  )
}

function Monogram({ label }: { label: string }) {
  return (
    <>
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
    </>
  )
}
