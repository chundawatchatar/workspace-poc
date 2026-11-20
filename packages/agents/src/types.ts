/** One shape of a vendor's mark, with its path data exactly as in the vendor's file. */
type MarkPath = { d: string; fill?: string; fillOpacity?: number; fillRule?: 'evenodd'; clipRule?: 'evenodd' }

/** A vendor's official mark, where it comes from, and the vendor's terms for using it. */
export type AgentMark = {
  /** The `viewBox` of the vendor's file. */
  viewBox: string
  paths: readonly MarkPath[]
  /**
   * `currentColor` draws a one-colour mark in the text colour around it;
   * `fixed` keeps each path's own colours, for a vendor that forbids recolouring.
   */
  colors: 'currentColor' | 'fixed'
  /** Space left on each side inside the 16-unit icon box, so the mark looks as big as a monogram. */
  inset: number
  /** The URL of the asset the paths come from. */
  source: string
  /** The URL of the vendor's brand page or licence. */
  terms: string
  /** What `terms` says about this use, in one line. */
  termsSummary: string
}

/** The title decorations an agent uses to report activity or status. */
export interface AgentTitleRules {
  spinners: string
  status: string
  braille: boolean
}

/** Browser-safe information about one agent, independent of how its process runs. */
export interface AgentDefinition {
  kind: string
  label: string
  initials: string
  icon?: AgentMark
  title: AgentTitleRules
}
