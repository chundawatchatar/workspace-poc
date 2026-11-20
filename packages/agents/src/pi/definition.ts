import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity and title rules for pi. */
export const definition = {
  kind: 'pi',
  label: 'pi',
  initials: 'PI',
  icon,
  title: standardTitleRules,
} as const satisfies AgentDefinition
