// The product's mark, defined once: the favicon of every app and the logo on the site are drawn from it.

/**
 * The mark as SVG markup: a window split into three panes, one of them ringing for attention. `color` may be a
 * CSS variable when the SVG is inline in a page; `fill` paints inside the frame.
 */
export function markSvg(options: { color: string; fill?: string; size?: number; title?: string }) {
  const { color, fill = 'none', size = 24, title } = options
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${title ? '' : ' aria-hidden="true"'}>`,
    title ? `<title>${title}</title>` : '',
    `<rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="${fill}" stroke="${color}" stroke-width="2"/>`,
    `<path d="M11 2.5v19M11 12h10.5" stroke="${color}" stroke-width="2"/>`,
    `<circle cx="16.25" cy="7" r="2.25" fill="${color}"/>`,
    '</svg>',
  ].join('')
}

/** The favicon, in the default dark theme's colours, as a data URL every app can put in `<link rel="icon">`. */
export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  markSvg({ color: '#3b82f6', fill: '#0c0d10', size: 32, title: 'Orchestrator' }),
)}`
