import { describe, expect, test } from 'bun:test'
import { placeholderRelay, preflight, publishPlan, releaseVersion } from './release'

/** The error a refusal gives, or the value. */
const outcome = <T>(result: { ok: true; value: T } | { ok: false; error: string }) =>
  result.ok ? result.value : result.error

describe('releaseVersion', () => {
  test('is the version of a v<semver> tag that matches the launcher template', () => {
    expect(outcome(releaseVersion('refs/tags/v0.1.0', '0.1.0'))).toBe('0.1.0')
    expect(outcome(releaseVersion('refs/tags/v0.2.0-beta.1', '0.2.0-beta.1'))).toBe('0.2.0-beta.1')
  })

  test('refuses another version, a non-semver tag or a branch, naming the ref and the template version', () => {
    for (const ref of ['refs/tags/v0.2.0', 'refs/tags/v0.1', 'refs/tags/release-0.1.0', 'refs/heads/main']) {
      const error = outcome(releaseVersion(ref, '0.1.0'))
      expect(error).toContain(ref)
      expect(error).toContain('is at 0.1.0')
    }
    expect(outcome(releaseVersion('refs/tags/v0.2.0', '0.1.0'))).toContain('releases 0.2.0')
    expect(outcome(releaseVersion('refs/tags/v01.0.0', '01.0.0'))).toContain('is not a release tag')
  })
})

describe('placeholderRelay', () => {
  test('accepts an ordinary wss:// host', () => {
    expect(placeholderRelay('wss://relay.corch.dev')).toBeNull()
    expect(placeholderRelay('wss://relay.corch.dev:8443/base')).toBeNull()
  })

  test('refuses ws://, loopback, and names reserved for examples and tests', () => {
    const refused = {
      'ws://relay.corch.dev': 'ws://',
      'https://relay.corch.dev': 'not a wss://',
      'not a url': 'not a URL',
      'wss://localhost': 'localhost',
      'wss://app.localhost': 'localhost',
      'wss://127.0.0.1': 'loopback',
      'wss://127.1.2.3:4600': 'loopback',
      'wss://[::1]': 'loopback',
      'wss://[::ffff:127.0.0.1]': 'loopback',
      'wss://example.com': 'example.com',
      'wss://orch.example.com': 'example.com',
      'wss://relay.EXAMPLE.net.': 'example.net',
      'wss://example.org': 'example.org',
      'wss://relay.example': 'example',
      'wss://relay.test': 'test',
      'wss://relay.invalid': 'invalid',
    }
    for (const [url, reason] of Object.entries(refused)) expect(placeholderRelay(url)).toContain(reason)
  })
})

describe('preflight', () => {
  const real = 'wss://relay.corch.dev'

  test('passes a tag run of the template version with a real relay address', () => {
    expect(preflight({ mode: { tag: 'refs/tags/v0.1.0' }, templateVersion: '0.1.0', relayUrl: real })).toEqual({
      ok: true,
      lines: ['Releasing corch 0.1.0'],
    })
  })

  test("fails a tag run while the built-in relay is today's placeholder, and only warns in a dry run", () => {
    const relayUrl = 'wss://orch.example.com'
    const tag = preflight({ mode: { tag: 'refs/tags/v0.1.0' }, templateVersion: '0.1.0', relayUrl })
    expect(tag.ok).toBe(false)
    expect(tag.lines).toHaveLength(1)
    expect(tag.lines[0]).toStartWith('::error::')
    expect(tag.lines[0]).toContain('DEFAULT_SERVER_URL in apps/host/src/modules/settings/settings.service.ts')

    const dryRun = preflight({ mode: { dryRun: true }, templateVersion: '0.1.0', relayUrl })
    expect(dryRun.ok).toBe(true)
    expect(dryRun.lines[0]).toBe(tag.lines[0]?.replace('::error::', '::warning::'))
  })

  test('fails a tag run of another version, with every finding', () => {
    const report = preflight({ mode: { tag: 'refs/tags/v0.2.0' }, templateVersion: '0.1.0', relayUrl: 'ws://x.test' })
    expect(report.ok).toBe(false)
    expect(report.lines.map((line) => line.slice(0, 9))).toEqual(['::error::', '::error::'])
    expect(report.lines[0]).toContain('releases 0.2.0')
  })
})

describe('publishPlan', () => {
  const tarballs = (version: string) =>
    ['corch', 'corch-darwin-arm64', 'corch-darwin-x64', 'corch-linux-arm64', 'corch-linux-x64'].map(
      (name) => `${name}-${version}.tgz`,
    )

  test('publishes the four platform packages, then the launcher, to latest', () => {
    expect(outcome(publishPlan(tarballs('0.1.0'), '0.1.0'))).toEqual({
      distTag: 'latest',
      steps: [
        { name: 'corch-darwin-arm64', file: 'corch-darwin-arm64-0.1.0.tgz' },
        { name: 'corch-darwin-x64', file: 'corch-darwin-x64-0.1.0.tgz' },
        { name: 'corch-linux-arm64', file: 'corch-linux-arm64-0.1.0.tgz' },
        { name: 'corch-linux-x64', file: 'corch-linux-x64-0.1.0.tgz' },
        { name: 'corch', file: 'corch-0.1.0.tgz' },
      ],
    })
  })

  test('sends a prerelease to next', () => {
    expect(outcome(publishPlan(tarballs('0.2.0-beta.1'), '0.2.0-beta.1'))).toMatchObject({ distTag: 'next' })
  })

  test('refuses a set with a tarball missing, extra or at another version, naming each', () => {
    const [launcher, ...platforms] = tarballs('0.1.0')
    expect(outcome(publishPlan(platforms, '0.1.0'))).toBe(`The tarballs for 0.1.0 don't match: missing ${launcher}`)
    expect(outcome(publishPlan([...tarballs('0.1.0'), 'corch-win32-x64-0.1.0.tgz'], '0.1.0'))).toBe(
      "The tarballs for 0.1.0 don't match: unexpected corch-win32-x64-0.1.0.tgz",
    )
    const mixed = outcome(publishPlan([...platforms, 'corch-0.0.9.tgz'], '0.1.0'))
    expect(mixed).toContain(`missing ${launcher}`)
    expect(mixed).toContain('unexpected corch-0.0.9.tgz')
  })
})
