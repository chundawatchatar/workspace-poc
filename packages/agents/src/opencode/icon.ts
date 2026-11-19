import type { AgentMark } from '../types'

/** The published OpenCode mark, with its original shape and source information. */
export const icon = {
  viewBox: '0 0 240 300',
  paths: [{ d: 'M180 240H60V120H180V240Z', fillOpacity: 0.28 }, { d: 'M180 60H60V240H180V60ZM240 300H0V0H240V300Z' }],
  colors: 'currentColor',
  inset: 0,
  source: 'https://opencode.ai/brand/files/opencode-logo-transparent-dark.svg',
  terms: 'https://opencode.ai/brand',
  termsSummary:
    "The default logo, one ink with its inner shade at 28%; tools should use a badge or partner lockup, the logo is at least 16x20 px and not recoloured; used on the product owner's decision.",
} satisfies AgentMark
