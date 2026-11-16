#!/usr/bin/env node

// The `corch` command npm installs. It runs the compiled executable from the `corch-<os>-<arch>` package npm
// installed for this platform, with the same arguments and terminal, and exits as it did. Plain JavaScript, so it
// runs under Node 18 or later and under Bun.

const { spawnSync } = require('node:child_process')
const { constants } = require('node:os')

/** The platforms a `corch-<os>-<arch>` package exists for, as `<process.platform>-<process.arch>`. */
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

/** The launcher's own version, which every platform package shares. */
const VERSION = require('../package.json').version

/** The one line for a platform no package exists for. */
function unsupportedMessage(platform, arch) {
  return `corch has no build for ${platform}-${arch}. It runs on ${PLATFORMS.join(', ')}.`
}

/** What to say when the platform package is not installed, as with `npm install --omit=optional`. */
function missingMessage(name) {
  return (
    `corch could not find its executable: the package ${name} is not installed. ` +
    `Reinstall with optional dependencies included: npm install --global corch@${VERSION} --include=optional`
  )
}

/**
 * The executable to run on `platform`-`arch`, or the message to exit with. `resolve` finds a package file from the
 * launcher's own folder, so the platform package is found nested under `corch` or beside it, as a global install
 * puts it.
 */
function findExecutable({ platform, arch, resolve }) {
  const key = `${platform}-${arch}`
  if (!PLATFORMS.includes(key)) return { error: unsupportedMessage(platform, arch) }
  const name = `corch-${key}`
  try {
    return { path: resolve(`${name}/bin/corch`) }
  } catch {
    return { error: missingMessage(name) }
  }
}

/** Runs the executable with this process's arguments and terminal, then exits with its code or its signal. */
function main() {
  const found = findExecutable({ platform: process.platform, arch: process.arch, resolve: require.resolve })
  if (found.error) {
    console.error(found.error)
    process.exit(1)
  }
  const result = spawnSync(found.path, process.argv.slice(2), { stdio: 'inherit' })
  if (result.error) {
    console.error(`corch could not run ${found.path}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) {
    // Dying from the same signal tells the shell what happened; the exit code is the fallback if it is ignored.
    process.kill(process.pid, result.signal)
    process.exit(128 + (constants.signals[result.signal] || 0))
  }
  process.exit(result.status === null ? 1 : result.status)
}

module.exports = { PLATFORMS, findExecutable, missingMessage, unsupportedMessage }

if (require.main === module) main()
