import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for Claude Code. */
export const definition = {
  kind: 'claude',
  label: 'Claude Code',
  initials: 'CC',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: true },
} as const satisfies AgentDefinition
