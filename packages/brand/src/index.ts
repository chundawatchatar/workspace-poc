// The product's name, subtitle and mark, defined once: the favicon of every app, the logo on the site and the frame of
// the client's auth pages are drawn from them.

/** The product's name, as every app and the site show it. */
export const PRODUCT_NAME = 'Orchestrator'

/** The one-line subtitle under the product's name. */
export const PRODUCT_TAGLINE = 'Your agents, your machine, any browser.'

/** The headline of the site's hero and the auth pages, in two sentences; the second is drawn in the accent colour. */
export const PRODUCT_HEADLINE = { lead: 'Run every agent at once.', accent: 'Know which one needs you.' } as const

/** The short facts in the pill above the headline. */
export const PRODUCT_FACTS = 'Free and open source · macOS and Linux · any browser'

/**
 * The mark as SVG markup: a window split into three panes, one of them ringing for attention. `color` may be a
 * CSS variable when the SVG is inline in a page; `fill` paints inside the frame. With `intro`, an inline mark draws
 * itself once, frame, then split, then the ringing pane's dot (`.mark-intro` in `styles.css`).
 */
export function markSvg(options: { color: string; fill?: string; size?: number; title?: string; intro?: boolean }) {
  const { color, fill = 'none', size = 24, title, intro = false } = options
  // `pathLength="1"` lets the CSS draw each stroke with a dash of length 1, whatever its real length.
  const part = (name: string) => (intro ? ` class="mark-${name}" pathLength="1"` : '')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${title ? '' : ' aria-hidden="true"'}${intro ? ' class="mark-intro"' : ''}>`,
    title ? `<title>${title}</title>` : '',
    `<rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="${fill}" stroke="${color}" stroke-width="2"${part('frame')}/>`,
    `<path d="M11 2.5v19M11 12h10.5" stroke="${color}" stroke-width="2"${part('split')}/>`,
    `<circle cx="16.25" cy="7" r="2.25" fill="${color}"${intro ? ' class="mark-dot"' : ''}/>`,
    '</svg>',
  ].join('')
}

/** The favicon, in the default dark theme's colours, as a data URL every app can put in `<link rel="icon">`. */
export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  markSvg({ color: '#3b82f6', fill: '#0c0d10', size: 32, title: PRODUCT_NAME }),
)}`
