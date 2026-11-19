import type { AgentTitleRules } from './types'

/** Decorations recognised by the existing terminal UI, shared until an agent needs narrower rules. */
export const standardTitleRules = {
  spinners: '◐◓◑◒✶✻✽✢·',
  status: '✳✦✧◇◆•●○⏺',
  braille: true,
} as const satisfies AgentTitleRules
