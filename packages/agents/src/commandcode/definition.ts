import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for Command Code. */
export const definition = {
  kind: 'commandcode',
  label: 'Command Code',
  initials: 'CM',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: false },
} as const satisfies AgentDefinition
