// What `.github/workflows/release.yml` decides before it builds or publishes `corch`: the version a tag releases,
// whether the built-in relay address can ship, and which tarballs go to npm in which order. Everything here is pure,
// so the tests check it without a tag, a build or the registry.

import { LAUNCHER_NAME, PLATFORMS } from './platforms'

/** The launcher template, whose `version` every release must match, as messages name it. */
export const TEMPLATE_PATH = 'apps/host/packaging/npm/corch/package.json'

/** Where the built-in relay address is set, as messages name it. */
export const RELAY_CONSTANT = 'DEFAULT_SERVER_URL in apps/host/src/modules/settings/settings.service.ts'

/** A value, or the reason there is none. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

// Semantic versioning's own grammar, without build metadata, which npm drops from a published version.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

/**
 * The version a git ref releases. Only a tag `refs/tags/v<version>` releases, and only the version the launcher
 * template is at, so a tag can't publish something the build doesn't say it is. Each refusal names the ref and the
 * template's version.
 */
export function releaseVersion(ref: string, templateVersion: string): Outcome<string> {
  const version = ref.match(/^refs\/tags\/v(.+)$/)?.[1]
  const expected = `refs/tags/v${templateVersion}`
  if (version === undefined || !SEMVER.test(version)) {
    return {
      ok: false,
      error: `${ref} is not a release tag: a release is a tag v<semver>, and ${TEMPLATE_PATH} is at ${templateVersion}, so it is ${expected}`,
    }
  }
  if (version !== templateVersion) {
    return {
      ok: false,
      error: `${ref} releases ${version}, but ${TEMPLATE_PATH} is at ${templateVersion}. Bump the template and merge it, or tag ${expected}`,
    }
  }
  return { ok: true, value: version }
}

// Names that never reach a real server: RFC 2606's example domains and reserved top-level domains, and RFC 6761's.
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org', 'example', 'test', 'invalid', 'localhost']

/** True when `host` (a URL's `hostname`) is a loopback address: `127.0.0.0/8`, `0.0.0.0` or IPv6 `::1`, `::`. */
function isLoopback(host: string): boolean {
  if (/^127(\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0') return true
  // The URL parser writes IPv6 in brackets, and an IPv4-mapped loopback as `::ffff:7fxx:xxxx`.
  return host === '[::1]' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
}

/**
 * Why a relay address can't be the one a release has built in, or null when it can: it must be `wss://` on a host a
 * user's machine can reach, not loopback and not a name reserved for examples or tests.
 */
export function placeholderRelay(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${url} is not a URL`
  }
  if (parsed.protocol === 'ws:') return `${url} uses ws://, which is unencrypted; a release needs wss://`
  if (parsed.protocol !== 'wss:') return `${url} is not a wss:// address`
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isLoopback(host)) return `${url} is a loopback address, which only reaches the user's own machine`
  const reserved = RESERVED_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`))
  if (reserved !== undefined) return `${url} is under ${reserved}, which is reserved and never reaches a real server`
  return null
}

/** What `release:check` is asked: a tag run, which must release, or a dry run, which only warns. */
export type PreflightMode = { tag: string } | { dryRun: true }

/** What the preflight prints, as GitHub annotations, and whether the run may go on. */
export interface PreflightReport {
  ok: boolean
  lines: string[]
}

/**
 * The preflight before any build. A tag run must release the template's version, and the built-in relay address must
 * be a real one, else it fails. A dry run, on a pull request, has no tag and builds with today's address, so the same
 * relay finding is a warning there.
 */
export function preflight({
  mode,
  templateVersion,
  relayUrl,
}: {
  mode: PreflightMode
  templateVersion: string
  relayUrl: string
}): PreflightReport {
  const errors: string[] = []
  const warnings: string[] = []
  const version = releaseVersion('tag' in mode ? mode.tag : `refs/tags/v${templateVersion}`, templateVersion)
  if (!version.ok) errors.push(version.error)
  const relay = placeholderRelay(relayUrl)
  if (relay !== null) {
    const finding = `The built-in relay address can't ship: ${relay}. Set ${RELAY_CONSTANT} to the production wss:// address before tagging a release.`
    if ('tag' in mode) errors.push(finding)
    else warnings.push(finding)
  }
  const lines = [...errors.map((line) => `::error::${line}`), ...warnings.map((line) => `::warning::${line}`)]
  if (errors.length === 0) {
    lines.push(
      'tag' in mode
        ? `Releasing corch ${templateVersion}`
        : `Dry run of corch ${templateVersion}: nothing is published`,
    )
  }
  return { ok: errors.length === 0, lines }
}

/** One tarball to publish: the package it holds and its file name. */
export interface PublishStep {
  name: string
  file: string
}

/** The tarballs to publish, in order, and the npm dist-tag they get. */
export interface PublishPlan {
  steps: PublishStep[]
  distTag: 'latest' | 'next'
}

/**
 * Which tarballs a release publishes, from the file names in its folder. It needs exactly the four platform packages
 * and the launcher, at `version`, and refuses anything missing or extra before anything is published. The platform
 * packages go first, so the launcher never names an optional dependency the registry doesn't have. A prerelease
 * (`0.2.0-beta.1`) goes to `next`, so `npm i -g corch` keeps installing the last stable release.
 */
export function publishPlan(tarballNames: string[], version: string): Outcome<PublishPlan> {
  if (!SEMVER.test(version)) return { ok: false, error: `${version} is not a semver version` }
  const steps = [...PLATFORMS.map((target) => target.npmName), LAUNCHER_NAME].map((name) => ({
    name,
    file: `${name}-${version}.tgz`,
  }))
  const missing = steps.map((step) => step.file).filter((file) => !tarballNames.includes(file))
  const extra = tarballNames.filter((file) => !steps.some((step) => step.file === file))
  if (missing.length > 0 || extra.length > 0) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : null,
      extra.length > 0 ? `unexpected ${extra.join(', ')}` : null,
    ]
    return { ok: false, error: `The tarballs for ${version} don't match: ${parts.filter(Boolean).join('; ')}` }
  }
  return { ok: true, value: { steps, distTag: version.includes('-') ? 'next' : 'latest' } }
}

/** The npm `dist.integrity` of a tarball, `sha512-<base64 digest>`: npm publishes a tarball's bytes as they are. */
export function tarballIntegrity(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
}

/**
 * The steps of a plan still to publish, given each tarball's `integrity` here and what the registry already has at the
 * release's version: null when it has none, else that version's `dist.integrity` (empty when the registry gives none).
 * A version already there is skipped only when it holds these exact bytes, so a re-run after a partial failure
 * finishes the release. Any other bytes, whether from an earlier build or someone else's package, refuse the whole
 * release before anything is published, naming each package, since npm never replaces a published version.
 */
export function stepsToPublish(
  plan: PublishPlan,
  integrity: Record<string, string>,
  registry: Record<string, string | null>,
): Outcome<PublishStep[]> {
  const conflicts = plan.steps.filter((step) => {
    const published = registry[step.name] ?? null
    return published !== null && published !== integrity[step.file]
  })
  if (conflicts.length > 0) {
    const names = conflicts.map((step) => step.name).join(', ')
    return {
      ok: false,
      error: `Already on the registry with other contents: ${names}. Nothing was published; a published version can't be replaced, so check who published it and release a new version.`,
    }
  }
  return { ok: true, value: plan.steps.filter((step) => (registry[step.name] ?? null) === null) }
}
