/**
 * The glyphs agents animate or show at the ends of their terminal titles. Every
 * one is a single UTF-16 unit, so the scans below read `charCodeAt`.
 */
const SPINNER_GLYPHS = '◐◓◑◒✶✻✽✢·'
const STATUS_GLYPHS = '✳✦✧◇◆•●○⏺'

const SPINNER_CODES = new Set(Array.from(SPINNER_GLYPHS, (glyph) => glyph.charCodeAt(0)))
const STATUS_CODES = new Set(Array.from(STATUS_GLYPHS, (glyph) => glyph.charCodeAt(0)))

/** True for a frame of an agent's title spinner. U+2800, the blank braille cell, is not one. */
function isSpinnerFrame(code: number) {
  return (code >= 0x2801 && code <= 0x28ff) || SPINNER_CODES.has(code)
}

/** True for an agent's glyph: a spinner frame or a status glyph such as Claude Code's resting `✳`. */
function isAgentGlyph(code: number) {
  return isSpinnerFrame(code) || STATUS_CODES.has(code)
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
export function titleSpins(title: string) {
  let index = 0
  while (index < title.length && isSpace(title.charCodeAt(index))) index += 1
  return index < title.length && isSpinnerFrame(title.charCodeAt(index))
}

/**
 * Removes agent glyphs and the whitespace around them from both ends of a
 * title, keeping any inside the text (`repo · main`). It walks inward from each
 * end once, so a long run of glyphs costs no more than its length.
 */
export function stripAgentGlyphs(title: string) {
  let start = 0
  let end = title.length
  while (start < end && isStripped(title.charCodeAt(start))) start += 1
  while (end > start && isStripped(title.charCodeAt(end - 1))) end -= 1
  return start === 0 && end === title.length ? title : title.slice(start, end)
}

/** True for what `stripAgentGlyphs` removes from the ends of a title. */
function isStripped(code: number) {
  return isSpace(code) || isAgentGlyph(code)
}
