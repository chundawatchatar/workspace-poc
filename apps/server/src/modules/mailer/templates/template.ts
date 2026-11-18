/** An email as a template renders it, before the mailer adds `from` and `to`. */
export interface RenderedMail {
  subject: string
  text: string
  html: string
}

/** One email the server sends. `render` turns its data into the subject, a plain-text body and an HTML body. */
export interface MailTemplate<Name extends string, Data> {
  name: Name
  render(data: Data): RenderedMail
}

/** Escapes `value` for HTML text and for a double- or single-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** What a single-link email says: a fixed subject, why it was sent, the button label and what to do if unexpected. */
export interface LinkEmail {
  subject: string
  intro: string
  action: string
  url: string
  outro: string
}

/**
 * Renders an email whose point is one link. The text part carries the URL
 * verbatim; the HTML part escapes every value, so a URL can't break out of
 * the `href` or inject markup. The subject is fixed by the template and never
 * holds user input.
 */
export function renderLinkEmail({ subject, intro, action, url, outro }: LinkEmail): RenderedMail {
  const text = `${intro}\n\n${action}: ${url}\n\n${outro}\n`
  const href = escapeHtml(url)
  const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a">
    <p>${escapeHtml(intro)}</p>
    <p><a href="${href}" style="font-weight: 600">${escapeHtml(action)}</a></p>
    <p style="font-size: 0.875em; color: #555">Or open this link: <a href="${href}">${href}</a></p>
    <p style="font-size: 0.875em; color: #555">${escapeHtml(outro)}</p>
  </body>
</html>
`
  return { subject, text, html }
}

/** What a code email says: a fixed subject, why it was sent, the code and what to do if unexpected. */
export interface CodeEmail {
  subject: string
  intro: string
  code: string
  outro: string
}

/**
 * Renders an email whose point is one short code to type into a page. The
 * code is in the body only, never in the subject, which a lock screen or a
 * mail list shows to anyone nearby.
 */
export function renderCodeEmail({ subject, intro, code, outro }: CodeEmail): RenderedMail {
  const text = `${intro}\n\n${code}\n\n${outro}\n`
  const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a">
    <p>${escapeHtml(intro)}</p>
    <p style="font-size: 1.5em; font-weight: 600"><code style="font-family: ui-monospace, Menlo, Consolas, monospace">${escapeHtml(code)}</code></p>
    <p style="font-size: 0.875em; color: #555">${escapeHtml(outro)}</p>
  </body>
</html>
`
  return { subject, text, html }
}

/** One link in a `LinksEmail`: its label and where it goes. */
export interface EmailLink {
  action: string
  url: string
}

/** What a several-link email says: a fixed subject, why it was sent, its links and what to do if unexpected. */
export interface LinksEmail {
  subject: string
  intro: string
  links: readonly EmailLink[]
  outro: string
}

/**
 * Renders an email that offers a few links to choose from, each on its own
 * line. Like `renderLinkEmail`, the text part carries every URL verbatim and
 * the HTML part escapes every value.
 */
export function renderLinksEmail({ subject, intro, links, outro }: LinksEmail): RenderedMail {
  const text = `${intro}\n\n${links.map(({ action, url }) => `${action}: ${url}`).join('\n')}\n\n${outro}\n`
  const items = links
    .map(
      ({ action, url }) => `    <p><a href="${escapeHtml(url)}" style="font-weight: 600">${escapeHtml(action)}</a></p>`,
    )
    .join('\n')
  const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a">
    <p>${escapeHtml(intro)}</p>
${items}
    <p style="font-size: 0.875em; color: #555">${escapeHtml(outro)}</p>
  </body>
</html>
`
  return { subject, text, html }
}
