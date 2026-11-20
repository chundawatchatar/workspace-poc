import type { SessionInfo } from '@orch/shared'
import { agentStatus } from './agentStatus'

/** `waiting` when an agent starts waiting for the user, `finished` when its turn ends. */
export type SoundCue = 'waiting' | 'finished'

/**
 * The cue an update of one session calls for, read from the status its tab
 * shows, which is the agent's own report in the standard status. A session
 * seen for the first time, one without an agent, and one whose tracking the
 * user switched off play nothing. A turn ends with a chime only when the agent
 * says it finished or failed: one the user interrupted goes back to `ready`.
 */
export function soundCue(previous: SessionInfo | undefined, next: SessionInfo): SoundCue | null {
  if (!previous || !next.agent || !next.alive || next.interrupted || !next.agentTracking) return null
  const before = agentStatus(previous)?.kind
  const after = agentStatus(next)?.kind
  if (after === 'waiting') return before === 'waiting' ? null : 'waiting'
  // A turn ends from working, or straight from waiting, as when a denied permission ends it.
  if (before !== 'working' && before !== 'waiting') return null
  const reason = next.agentState?.reason
  return reason === 'finished' || reason === 'error' ? 'finished' : null
}

/** The notes of each cue, in hertz: two rising notes ask for the user, one lower note says done. */
const NOTES: Record<SoundCue, number[]> = { waiting: [660, 880], finished: [523.25] }
const NOTE_GAP = 0.12
const NOTE_LENGTH = 0.25
const VOLUME = 0.15
/** Several terminals changing together play one cue, not a pile of them. */
const MIN_INTERVAL_MS = 400

let context: AudioContext | null = null
let lastPlayed = Number.NEGATIVE_INFINITY

/**
 * Creates or resumes the audio context. Safari lets audio sound only when this
 * runs inside a click, tap or key handler, so `listenForUnlock` and the sound
 * switch call it there; a cue from the events socket can't unlock it itself.
 */
export function unlockAudio() {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') context.resume().catch(() => {})
    // Older iOS unlocks only once a sound starts within the gesture, so this plays one silent sample.
    const source = context.createBufferSource()
    source.buffer = context.createBuffer(1, 1, context.sampleRate)
    source.connect(context.destination)
    source.start()
  } catch {
    // No Web Audio here: cues stay silent and the visual marks still show.
  }
}

const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'keydown'] as const

/**
 * Unlocks audio on the user's click, tap or key whenever it isn't running: the
 * first one, and again after a browser suspends it, as iOS does in the
 * background. While it runs a gesture costs nothing. Returns a stop function.
 */
export function listenForUnlock() {
  const unlock = () => {
    if (context?.state !== 'running') unlockAudio()
  }
  for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, true)
  return () => {
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, true)
  }
}

/**
 * Plays a cue as short sine tones, made here, so there is no audio file. It
 * sounds only once `unlockAudio` has run within a user gesture and the audio is
 * running; until then, and where there is no audio at all, it stays silent. It
 * never schedules tones on a suspended context, whose frozen clock would play
 * them all at once on the next gesture, even one that mutes.
 */
export function playCue(cue: SoundCue, now = Date.now()) {
  if (context?.state !== 'running' || now - lastPlayed < MIN_INTERVAL_MS) return
  lastPlayed = now
  try {
    const start = context.currentTime
    NOTES[cue].forEach((frequency, i) => {
      const audio = context as AudioContext
      const at = start + i * NOTE_GAP
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(VOLUME, at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(at)
      oscillator.stop(at + NOTE_LENGTH + 0.01)
    })
  } catch {
    // No Web Audio here, or the browser refused it: the visual mark still shows.
  }
}
