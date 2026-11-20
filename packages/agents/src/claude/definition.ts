import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for Claude Code. */
export const definition = {
  kind: 'claude',
  label: 'Claude Code',
  initials: 'CC',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
