import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for Command Code. */
export const definition = {
  kind: 'commandcode',
  label: 'Command Code',
  initials: 'CM',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
