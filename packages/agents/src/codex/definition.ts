import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for Codex. */
export const definition = {
  kind: 'codex',
  label: 'Codex',
  initials: 'CX',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
