// The sidebar's width lives in a CSS variable rather than in React state, so
// dragging the handle restyles one element without re-rendering the app.

export const SIDEBAR_WIDTH = { min: 180, max: 480, initial: 240 }

const KEY = 'poc-sidebar-width'
const VARIABLE = '--sidebar-width'

export function sidebarWidth(): number {
  const value = Number.parseInt(document.documentElement.style.getPropertyValue(VARIABLE), 10)
  return Number.isFinite(value) ? value : SIDEBAR_WIDTH.initial
}

/** Pass `persist: false` while a drag is in progress and save once at the end. */
export function setSidebarWidth(pixels: number, persist = true): number {
  const width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, pixels)))
  document.documentElement.style.setProperty(VARIABLE, `${width}px`)
  if (persist) {
    try {
      localStorage.setItem(KEY, String(width))
    } catch {}
  }
  return width
}

/** Inline script for the document head: restores the saved width before the first paint. */
export const SIDEBAR_BOOT_SCRIPT = `(function(){try{var w=parseInt(localStorage.getItem('${KEY}'),10);if(w>=${SIDEBAR_WIDTH.min}&&w<=${SIDEBAR_WIDTH.max})document.documentElement.style.setProperty('${VARIABLE}',w+'px')}catch(e){}})()`
