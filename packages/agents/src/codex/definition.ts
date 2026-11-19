import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for Codex. */
export const definition = {
  kind: 'codex',
  label: 'Codex',
  initials: 'CX',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: true },
} as const satisfies AgentDefinition
