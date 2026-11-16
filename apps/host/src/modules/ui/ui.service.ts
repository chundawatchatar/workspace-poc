import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { API_PREFIX, WS_PREFIX } from '@orch/shared'

// A copy of the cloud server's `static.service.ts`, without its relay paths. It stays a copy so this job leaves
// `apps/server` untouched; sharing it means moving the pure helpers to a server-only `@orch/shared` subpath.

/** What every kind of site holds about its page. */
interface UiPage {
  /** The bytes of `index.html` as they were at start-up, so they always match `csp`. */
  indexHtml: Uint8Array<ArrayBuffer>
  /** The `Content-Security-Policy` for `index.html`. */
  csp: string
}

/** A built local UI in a folder on disk, as the dev host serves it. */
export interface FolderUiSite extends UiPage {
  kind: 'folder'
  /** The real path of the folder, symlinks resolved. */
  root: string
}

/** A built local UI compiled into the executable, as the packaged host serves it. */
export interface EmbeddedUiSite extends UiPage {
  kind: 'embedded'
  /** Every file the site has, by URL path (`/assets/index-abc.js`), to the path `Bun.file` reads it from. */
  files: ReadonlyMap<string, string>
}

/** The built local UI the host serves, read once at start-up. */
export type UiSite = FolderUiSite | EmbeddedUiSite

/**
 * What a UI request resolves to: a file of the site, the page, or nothing. A file's `path` is where `Bun.file`
 * reads it, and its `sitePath` where it sits in the site, from `/`.
 */
export type UiTarget = { kind: 'file'; path: string; sitePath: string } | { kind: 'index' } | { kind: 'not-found' }

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const SRC_ATTRIBUTE = /\bsrc\s*=/i

/** The CSP source of each inline script in `html`, as `'sha256-…'`, in document order. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const [, attributes = '', body = ''] of html.matchAll(INLINE_SCRIPT)) {
    if (SRC_ATTRIBUTE.test(attributes)) continue
    hashes.push(`'sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}'`)
  }
  return hashes
}

/**
 * The `Content-Security-Policy` for an `index.html`, allowing exactly its inline scripts. `connect-src 'self'` also
 * covers the page's same-origin `ws:` sockets. Styles allow inline, since xterm and React set them.
 */
export function buildCsp(html: string): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...inlineScriptHashes(html)].join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Reads the UI folder at start-up. Null means it has no readable `index.html`, so there is no UI to serve. */
export async function loadUiSite(dir: string): Promise<FolderUiSite | null> {
  try {
    const root = await realpath(dir)
    return { kind: 'folder', root, ...(await readPage(join(root, 'index.html'))) }
  } catch {
    return null
  }
}

/**
 * Reads the site embedded in the executable at start-up, from `files`, its file paths by URL path. Null means it
 * has no readable `/index.html`, so there is no UI to serve.
 */
export async function loadEmbeddedUiSite(files: Readonly<Record<string, string>>): Promise<EmbeddedUiSite | null> {
  const index = files['/index.html']
  if (index === undefined) return null
  try {
    return { kind: 'embedded', files: new Map(Object.entries(files)), ...(await readPage(index)) }
  } catch {
    return null
  }
}

async function readPage(path: string): Promise<UiPage> {
  const indexHtml = new Uint8Array(await Bun.file(path).arrayBuffer())
  return { indexHtml, csp: buildCsp(new TextDecoder().decode(indexHtml)) }
}

/** True for the API's and the sockets' paths, which the UI never answers, not even with the page. */
export function isApiPath(pathname: string): boolean {
  return [API_PREFIX, WS_PREFIX].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Resolves a request path against the site. A file of the site is served as
 * is. A path that names no file falls back to the page when the browser asks
 * for HTML, for the UI's own routes (`/w/<id>`). Dot segments, dotfiles,
 * encoded slashes and paths that leave a folder through a symlink resolve to
 * nothing, and so does anything under the API or socket prefixes. A folder
 * site and an embedded one with the same files give the same answers.
 */
export async function resolveUi(site: UiSite, rawPath: string, acceptsHtml: boolean): Promise<UiTarget> {
  const notFound: UiTarget = { kind: 'not-found' }
  if (isApiPath(rawPath)) return notFound
  const segments = decodeSegments(rawPath)
  if (!segments) return notFound
  // Checked again once decoded, so `/%61pi/…` can't reach the page either.
  if (isApiPath(`/${segments.join('/')}`)) return notFound
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) return { kind: 'index' }

  const found = site.kind === 'folder' ? await folderFile(site, segments) : embeddedFile(site, segments)
  if (found === 'refused') return notFound
  if (found) return found
  return acceptsHtml ? { kind: 'index' } : notFound
}

type FoundFile = Extract<UiTarget, { kind: 'file' }> | 'refused' | null

/** The file `segments` name in the folder. Null means there is none, and `refused` that a symlink leaves the folder. */
async function folderFile(site: FolderUiSite, segments: string[]): Promise<FoundFile> {
  try {
    const path = await realpath(join(site.root, ...segments))
    // A symlink out of the folder is refused outright, not answered with the page.
    if (!path.startsWith(site.root + sep)) return 'refused'
    if ((await stat(path)).isFile()) return { kind: 'file', path, sitePath: path.slice(site.root.length) }
  } catch {
    // No such file.
  }
  return null
}

/** The embedded file `segments` name, or null when the site has none by that exact path. */
function embeddedFile(site: EmbeddedUiSite, segments: string[]): FoundFile {
  const sitePath = `/${segments.join('/')}`
  const path = site.files.get(sitePath)
  return path === undefined ? null : { kind: 'file', path, sitePath }
}

/** The decoded segments of a URL path, ignoring empty ones. Null means a segment is unsafe to join to a folder. */
function decodeSegments(rawPath: string): string[] | null {
  const segments: string[] = []
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (segment.startsWith('.') || /[/\\\0]/.test(segment)) return null
    segments.push(segment)
  }
  return segments
}
