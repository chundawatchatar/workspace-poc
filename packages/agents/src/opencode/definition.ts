import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for OpenCode. */
export const definition = {
  kind: 'opencode',
  label: 'OpenCode',
  initials: 'OC',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
