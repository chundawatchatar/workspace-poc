import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for Cursor Agent. */
export const definition = {
  kind: 'cursor',
  label: 'Cursor Agent',
  initials: 'CU',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
