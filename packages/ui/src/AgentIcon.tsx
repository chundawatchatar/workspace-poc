import type { AgentKind } from '@orch/shared'
import { cn } from './lib/utils'

/** One shape of a vendor's mark, with its path data exactly as in the vendor's file. */
type MarkPath = { d: string; fill?: string; fillOpacity?: number; fillRule?: 'evenodd'; clipRule?: 'evenodd' }

/** A vendor's official mark, where it comes from, and the vendor's terms for using it. */
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
  /** The URL of the vendor's brand page or licence. */
  terms: string
  /** What `terms` says about this use, in one line. */
  termsSummary: string
}

/**
 * How each agent kind is told apart in tabs and sidebar rows. `label` is its
 * short monogram, distinct from every other kind's, since several agents'
 * names start with the same letter. A kind with a `mark` draws its vendor's
 * official mark instead; without one it draws the `label` in a rounded square.
 *
 * Every mark is the vendor's own published file, with its path data copied
 * unchanged; a look-alike, simplified or redrawn logo is never drawn. Pages
 * read on 2026-11-19. Decision per kind:
 * - `cursor` (Cursor Agent), `pi` (pi) and `commandcode` (Command Code): their
 *   brand pages permit this use. The cube and the badge draw in the text
 *   colour, and Command Code's logomark in its fixed colours.
 * - `claude` (Claude Code), `codex` (Codex) and `opencode` (OpenCode): the
 *   product owner chose to show their official marks although their terms
 *   don't clearly permit it here. Anthropic allows its marks only in materials
 *   it approves beforehand, OpenAI's brand page couldn't be read, and OpenCode
 *   sets a 16x20 px minimum, larger than the 13 px and 10 px slots. Each still
 *   keeps the colour rules its vendor publishes where it can: the Claude spark
 *   stays in its own clay colour, and the OpenCode logo keeps its one ink with
 *   the inner shade at the file's opacity.
 * The marks' sources and terms are in their entries below.
 */
export const AGENT_ICONS: Record<AgentKind, { label: string; mark?: AgentMark }> = {
  claude: {
    label: 'CC',
    mark: {
      viewBox: '0 0 94 94',
      paths: [
        {
          d: 'M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z',
          fill: '#D97757',
        },
      ],
      colors: 'fixed',
      inset: 0,
      source:
        'https://www.anthropic.com/press-kit#Anthropic%20logos/Claude%20logos/3%20Claude%20Spark/SVG/Claude%20Spark%20-%20Clay.svg',
      terms: 'https://www.anthropic.com/legal/trademark-guidelines',
      termsSummary:
        'Marks only "in materials we approve beforehand", with no colour changes; used on the product owner\'s decision, in the file\'s own colour.',
    },
  },
  codex: {
    label: 'CX',
    mark: {
      viewBox: '100 100 411 411',
      paths: [
        {
          d: 'M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z',
          fillRule: 'evenodd',
          clipRule: 'evenodd',
        },
      ],
      colors: 'currentColor',
      inset: 0,
      source: 'https://developers.openai.com/codex',
      terms: 'https://openai.com/brand',
      termsSummary:
        "The OpenAI mark from the header of OpenAI's Codex docs, drawn there in `currentColor`; the brand page refuses scripted fetches, so its terms weren't read, and it is used on the product owner's decision.",
    },
  },
  opencode: {
    label: 'OC',
    mark: {
      viewBox: '0 0 240 300',
      paths: [
        { d: 'M180 240H60V120H180V240Z', fillOpacity: 0.28 },
        { d: 'M180 60H60V240H180V60ZM240 300H0V0H240V300Z' },
      ],
      colors: 'currentColor',
      inset: 0,
      source: 'https://opencode.ai/brand/files/opencode-logo-transparent-dark.svg',
      terms: 'https://opencode.ai/brand',
      termsSummary:
        "The default logo, one ink with its inner shade at 28%; tools should use a badge or partner lockup, the logo is at least 16x20 px and not recoloured; used on the product owner's decision.",
    },
  },
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
      termsSummary:
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
      termsSummary:
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
      termsSummary:
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
          fillOpacity={path.fillOpacity}
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
