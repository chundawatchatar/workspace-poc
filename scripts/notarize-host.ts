import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type LauncherTemplate, PLATFORMS, platformKey } from '../apps/host/packaging/platforms'

/**
 * `bun scripts/notarize-host.ts --target darwin-<arch>`: submits the signed
 * `corch` executable `package:host` built for a darwin target to Apple's
 * notary service and waits for the verdict, failing unless it is `Accepted`.
 * Only on failure does it print Apple's log for the submission. It then checks
 * that `bin/corch` in the packed tarball is byte for byte the file it
 * submitted, so the release publishes what Apple accepted. A bare executable
 * can't be stapled, so Gatekeeper checks the notarization online.
 *
 * It signs in with an App Store Connect API key from `APPLE_NOTARY_KEY_P8`
 * (the `.p8` file's contents), `APPLE_NOTARY_KEY_ID` and
 * `APPLE_NOTARY_ISSUER_ID`. The key goes only into
 * `$RUNNER_TEMP/corch-notary-key.p8`, mode 0600, which it removes when done
 * (the workflow removes it again in an `always()` step); the key id and issuer
 * id are identifiers, not credentials, and are passed as arguments.
 */

const root = resolve(import.meta.dir, '..')
const out = join(root, 'dist/package')
const temp = process.env.RUNNER_TEMP || tmpdir()
const keyFile = join(temp, 'corch-notary-key.p8')

function fail(message: string): never {
  console.error(`notarize: ${message}`)
  rmSync(keyFile, { force: true })
  process.exit(1)
}

const args = process.argv.slice(2)
const target = PLATFORMS.find((candidate) => args[0] === '--target' && platformKey(candidate) === args[1])
if (args.length !== 2 || !target || target.os !== 'darwin') fail('use --target darwin-arm64 or --target darwin-x64')

const { APPLE_NOTARY_KEY_P8: key, APPLE_NOTARY_KEY_ID: keyId, APPLE_NOTARY_ISSUER_ID: issuer } = process.env
if (!key || !keyId || !issuer) fail('APPLE_NOTARY_KEY_P8, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID must be set')

const { version } = JSON.parse(
  readFileSync(join(root, 'apps/host/packaging/npm/corch/package.json'), 'utf8'),
) as LauncherTemplate
const executable = join(out, 'npm', target.npmName, 'bin/corch')
const tarball = join(out, 'tarballs', `${target.npmName}-${version}.tgz`)
const zip = join(temp, `${target.npmName}-${version}.zip`)
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

const submitted = sha256(readFileSync(executable))
const ditto = Bun.spawnSync(['ditto', '-c', '-k', '--keepParent', executable, zip], { stderr: 'inherit' })
if (ditto.exitCode !== 0) fail(`zipping ${target.npmName} failed (exit ${ditto.exitCode})`)

writeFileSync(keyFile, key, { mode: 0o600 })
chmodSync(keyFile, 0o600)
const credentials = ['--key', keyFile, '--key-id', keyId, '--issuer', issuer]

console.log(`Notarizing ${target.npmName} ${version} (sha256 ${submitted}); this waits for Apple's verdict`)
const submit = Bun.spawnSync(
  ['xcrun', 'notarytool', 'submit', zip, ...credentials, '--wait', '--timeout', '1h', '--output-format', 'json'],
  { stdout: 'pipe', stderr: 'inherit' },
)
rmSync(zip, { force: true })
let verdict: { id?: string; status?: string } = {}
try {
  verdict = JSON.parse(submit.stdout.toString()) as typeof verdict
} catch {
  // A failure before Apple answers prints no JSON; the status check below reports it.
}
if (verdict.status !== 'Accepted') {
  if (verdict.id) {
    console.error(`Notary log for submission ${verdict.id}:`)
    Bun.spawnSync(['xcrun', 'notarytool', 'log', verdict.id, ...credentials], { stdout: 'inherit', stderr: 'inherit' })
  }
  fail(`${target.npmName} was not notarized: status ${verdict.status ?? `unknown (exit ${submit.exitCode})`}`)
}
rmSync(keyFile, { force: true })

const packed = Bun.spawnSync(['tar', '-xzOf', tarball, 'package/bin/corch'], { stdout: 'pipe', stderr: 'inherit' })
if (packed.exitCode !== 0) fail(`reading bin/corch from ${tarball} failed (exit ${packed.exitCode})`)
if (sha256(packed.stdout) !== submitted) fail(`bin/corch in ${tarball} is not the executable Apple notarized`)
console.log(`Accepted: ${target.npmName} ${version}, and its tarball holds the notarized executable`)
