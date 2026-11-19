import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for Cursor Agent. */
export const definition = {
  kind: 'cursor',
  label: 'Cursor Agent',
  initials: 'CU',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: false },
} as const satisfies AgentDefinition
