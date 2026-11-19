import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for OpenCode. */
export const definition = {
  kind: 'opencode',
  label: 'OpenCode',
  initials: 'OC',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: false },
} as const satisfies AgentDefinition
