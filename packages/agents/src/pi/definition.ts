import { standardTitleRules } from '../title-rules'
import type { AgentDefinition } from '../types'
import { icon } from './icon'

/** The identity, title rules and supported integrations for pi. */
export const definition = {
  kind: 'pi',
  label: 'pi',
  initials: 'PI',
  icon,
  title: standardTitleRules,
  capabilities: { hooks: false },
} as const satisfies AgentDefinition
