import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORMS, platformKey } from './platforms'

/** The launcher's exports. It is plain JavaScript, so its shape is declared here. */
interface Launcher {
  PLATFORMS: string[]
  findExecutable(input: {
    platform: string
    arch: string
    resolve: (request: string) => string
  }): { path: string } | { error: string }
}

const launcherFile = join(import.meta.dir, 'npm/corch/bin/corch.js')
const launcher = require(launcherFile) as Launcher
const { version } = JSON.parse(readFileSync(join(import.meta.dir, 'npm/corch/package.json'), 'utf8'))
const here = `corch-${process.platform}-${process.arch}`
// The launcher runs under Node and Bun alike, so each test runs it with every one this machine has.
const runtimes = [process.execPath, Bun.which('node')].filter((path): path is string => !!path)

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * Installs the launcher in a temporary `node_modules` and, unless `platformAt` is null, a fake executable for this
 * platform in `platformAt`, relative to the `corch` package. It prints its arguments and exits 7, or kills itself
 * with SIGTERM when its first argument is `kill`.
 */
function install(platformAt: string | null) {
  dir = mkdtempSync(join(tmpdir(), 'corch-launcher-'))
  const corch = join(dir, 'node_modules/corch')
  mkdirSync(join(corch, 'bin'), { recursive: true })
  copyFileSync(launcherFile, join(corch, 'bin/corch.js'))
  copyFileSync(join(import.meta.dir, 'npm/corch/package.json'), join(corch, 'package.json'))
  if (platformAt !== null) {
    const executable = join(corch, platformAt, here, 'bin/corch')
    mkdirSync(dirname(executable), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\n[ "$1" = kill ] && kill -TERM $$\necho "args: $*"\nexit 7\n')
    chmodSync(executable, 0o755)
  }
  return join(corch, 'bin/corch.js')
}

async function runLauncher(runtime: string, script: string, args: string[]) {
  const child = Bun.spawn([runtime, script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  return { code: child.exitCode, signal: child.signalCode, stdout, stderr }
}

describe('the corch launcher', () => {
  test('knows the same platforms the build makes packages for', () => {
    expect(launcher.PLATFORMS).toEqual(PLATFORMS.map(platformKey))
  })

  test('names an unsupported platform in one line with the supported ones', () => {
    const resolve = () => '/unused'
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['linux', 'ia32'],
    ]) {
      const found = launcher.findExecutable({ platform: platform as string, arch: arch as string, resolve })
      expect(found).toEqual({
        error: `corch has no build for ${platform}-${arch}. It runs on darwin-arm64, darwin-x64, linux-arm64, linux-x64.`,
      })
    }
  })

  test('runs the platform executable nested or beside it, with its arguments, exit code and signal', async () => {
    for (const layout of ['node_modules', '..']) {
      const script = install(layout)
      for (const runtime of runtimes) {
        expect(await runLauncher(runtime, script, ['status', '--data-dir', 'a b'])).toEqual({
          code: 7,
          signal: null,
          stdout: 'args: status --data-dir a b\n',
          stderr: '',
        })
        expect(await runLauncher(runtime, script, ['kill'])).toMatchObject({ code: null, signal: 'SIGTERM' })
      }
      rmSync(dir as string, { recursive: true, force: true })
    }
  })

  test('without its platform package, names the package and how to reinstall, and exits 1', async () => {
    const script = install(null)
    for (const runtime of runtimes) {
      const { code, stderr } = await runLauncher(runtime, script, ['status'])
      expect(code).toBe(1)
      expect(stderr).toContain(`the package ${here} is not installed`)
      expect(stderr).toContain(`npm install --global corch@${version} --include=optional`)
    }
  })
})
