import { AGENT_DEFINITIONS, type AgentKind } from './registry'
import { standardTitleRules } from './title-rules'
import type { AgentTitleRules } from './types'

/** True for a frame of an agent's title spinner. U+2800, the blank braille cell, is not one. */
function isSpinnerFrame(code: number, rules: AgentTitleRules) {
  return (rules.braille && code >= 0x2801 && code <= 0x28ff) || rules.spinners.includes(String.fromCharCode(code))
}

/** True for an agent's glyph: a spinner frame or a status glyph such as Claude Code's resting `✳`. */
function isAgentGlyph(code: number, rules: AgentTitleRules) {
  return isSpinnerFrame(code, rules) || rules.status.includes(String.fromCharCode(code))
}

/** True for the whitespace `String.prototype.trim` removes. */
function isSpace(code: number) {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

/** True when the title's first character after any whitespace is a spinner frame, as while an agent runs a turn. */
export function titleSpins(title: string, kind?: AgentKind) {
  const rules = kind ? AGENT_DEFINITIONS[kind].title : standardTitleRules
  let index = 0
  while (index < title.length && isSpace(title.charCodeAt(index))) index += 1
  return index < title.length && isSpinnerFrame(title.charCodeAt(index), rules)
}

/**
 * Removes agent glyphs and the whitespace around them from both ends of a
 * title, keeping any inside the text (`repo · main`). It walks inward from each
 * end once, so a long run of glyphs costs no more than its length.
 */
export function stripAgentGlyphs(title: string, kind?: AgentKind) {
  const rules = kind ? AGENT_DEFINITIONS[kind].title : standardTitleRules
  let start = 0
  let end = title.length
  while (start < end && isStripped(title.charCodeAt(start), rules)) start += 1
  while (end > start && isStripped(title.charCodeAt(end - 1), rules)) end -= 1
  return start === 0 && end === title.length ? title : title.slice(start, end)
}

/** True for what `stripAgentGlyphs` removes from the ends of a title. */
function isStripped(code: number, rules: AgentTitleRules) {
  return isSpace(code) || isAgentGlyph(code, rules)
}
