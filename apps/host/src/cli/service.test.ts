import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routes } from '@orch/shared'
import { SETTING_FLAGS } from '../modules/settings/settings.service'
import { runCli } from './cli'
import { lockPath, readRunFile, removeProcessFiles, runFilePath, writeRunFile } from './process-files'
import { type CommandResult, type ServiceDeps, serviceDeps, serviceName } from './service'
import { launchdLabel, launchdPlist } from './service-launchd'
import { systemdUnit } from './service-systemd'

const SELF = ['/opt/corch/bin/corch']
const ODD = `/tmp/a b"c&d<e>f%g$h'i\\j`

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Reads the plist subset `launchdPlist` writes (dict, array, string, true, false), decoding XML entities. */
function parsePlist(xml: string): unknown {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*<!DOCTYPE[^>]*>\s*<plist version="1.0">/, '').replace(/<\/plist>\s*$/, '')
  const tokens = (body.match(/<[^>]+>|[^<]+/g) ?? []).filter((token) => token.trim() !== '')
  const entities: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }
  const decode = (text: string) => {
    // As in XML, a bare `&` is an error, not a literal.
    expect(text.replace(/&(lt|gt|quot|apos|amp);/g, '')).not.toContain('&')
    return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => entities[name] ?? '')
  }
  let at = 0
  const take = () => tokens[at++] as string
  const value = (): unknown => {
    const tag = take()
    if (tag === '<true/>') return true
    if (tag === '<false/>') return false
    if (tag === '<string>') {
      const text = tokens[at] === '</string>' ? '' : decode(take())
      expect(take()).toBe('</string>')
      return text
    }
    if (tag === '<array>') {
      const items: unknown[] = []
      while (tokens[at] !== '</array>') items.push(value())
      take()
      return items
    }
    if (tag === '<dict>') {
      const dict: Record<string, unknown> = {}
      while (tokens[at] !== '</dict>') {
        expect(take()).toBe('<key>')
        const key = decode(take())
        expect(take()).toBe('</key>')
        dict[key] = value()
      }
      take()
      return dict
    }
    throw new Error(`unexpected ${tag}`)
  }
  const parsed = value()
  expect(at).toBe(tokens.length)
  return parsed
}

/**
 * Splits an `ExecStart` line as systemd does: `%%` is a literal `%` and any other `%` a specifier, words split on
 * unquoted spaces, quotes take C escapes, and `$$` is a literal `$` and any other `$` a variable.
 */
function execStartArgs(line: string): string[] {
  expect(line.replace(/%%/g, '')).not.toContain('%')
  const text = line.replace(/%%/g, '%')
  const escapes: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"', "'": "'" }
  const words: string[] = []
  let word: string | null = null
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (quote && char === quote) quote = null
    else if (quote && char === '\\') {
      const next = text[++i] as string
      if (next === 'x') {
        word += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 3), 16))
        i += 2
      } else if (next in escapes) word += escapes[next]
      else throw new Error(`unknown escape \\${next}`)
    } else if (quote) word += char
    else if (char === ' ') {
      if (word !== null) words.push(word)
      word = null
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else word = (word ?? '') + char
  }
  expect(quote).toBeNull()
  if (word !== null) words.push(word)
  return words.map((each) => {
    expect(each.replace(/\$\$/g, '')).not.toContain('$')
    return each.replace(/\$\$/g, '$')
  })
}

/** The value of each `key=value` line in a unit. */
const unitValues = (unit: string, key: string) =>
  unit
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1))

describe('serviceName', () => {
  test('is corch for the default data folder and corch-<hash> for any other, with a matching launchd label', () => {
    expect(serviceName('/home/u/.corch/', '/home/u/.corch')).toBe('corch')
    const other = serviceName('/tmp/x', '/home/u/.corch')
    expect(other).toMatch(/^corch-[0-9a-f]{12}$/)
    expect(serviceName('/tmp/x/', '/home/u/.corch')).toBe(other)
    expect(serviceName('/tmp/y', '/home/u/.corch')).not.toBe(other)
    expect(launchdLabel('corch')).toBe('corch.host')
    expect(launchdLabel(other)).toBe(`corch.host.${other.slice('corch-'.length)}`)
  })
})

describe('unit files', () => {
  const programArguments = [...SELF, 'run', '--background', '--data-dir', ODD]

  test('the plist runs the host at load, relaunches only a failure and keeps every value as given', () => {
    const plist = parsePlist(launchdPlist({ label: 'corch.host', programArguments, dataDir: ODD }))
    expect(plist).toEqual({
      Label: 'corch.host',
      ProgramArguments: programArguments,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      AbandonProcessGroup: true,
      ProcessType: 'Interactive',
      StandardOutPath: `${ODD}/corch.service.log`,
      StandardErrorPath: `${ODD}/corch.service.log`,
    })
  })

  test('the systemd unit restarts only a failure, signals only the host and keeps every argument as given', () => {
    const unit = systemdUnit({ programArguments, dataDir: ODD })
    const [execStart, ...more] = unitValues(unit, 'ExecStart')
    expect(more).toEqual([])
    expect(execStartArgs(execStart as string)).toEqual(programArguments)
    const controls = ['/c', 'a\nb\x01']
    const quoted = unitValues(systemdUnit({ programArguments: controls, dataDir: ODD }), 'ExecStart')[0] as string
    expect(quoted).not.toContain('\n')
    expect(execStartArgs(quoted)).toEqual(controls)
    expect(unitValues(unit, 'Restart')).toEqual(['on-failure'])
    expect(unitValues(unit, 'RestartPreventExitStatus')).toEqual(['4'])
    expect(unitValues(unit, 'KillMode')).toEqual(['process'])
    expect(unitValues(unit, 'WantedBy')).toEqual(['default.target'])
    expect(unit).not.toContain('Environment')
  })
})

interface FakeHost {
  instanceId: string
  pid: number
  stop: () => Promise<void>
}

/**
 * A stand-in for a host: a `sleep` as its pid, a server answering its instance id, and its process files, which go
 * when the pid exits, as a real host removes them on SIGTERM.
 */
async function fakeHost(dataDir: string): Promise<FakeHost> {
  const instanceId = crypto.randomUUID()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === routes.system.instance.path
        ? Response.json({ instanceId })
        : new Response(null, { status: 404 }),
  })
  const sleeper = Bun.spawn(['sleep', '60'])
  const record = { pid: sleeper.pid, instanceId, startedAt: Date.now() }
  writeFileSync(lockPath(dataDir), JSON.stringify(record))
  writeRunFile(dataDir, { ...record, url: `http://127.0.0.1:${server.port}` })
  const exited = sleeper.exited.then(() => {
    removeProcessFiles(dataDir, instanceId)
    server.stop(true)
  })
  const stop = async () => {
    sleeper.kill('SIGTERM')
    await exited
  }
  cleanups.push(stop)
  return { instanceId, pid: sleeper.pid, stop }
}

interface Setup {
  dataDir: string
  unitDir: string
  deps: ServiceDeps
  /** Every command run through the seam, as one line each. */
  calls: string[]
  out: string[]
  err: string[]
  /** The fake manager's host, if it runs one. */
  host: () => FakeHost | null
  /** Runs `corch <args> --data-dir <dataDir>` in this process, through the fake manager. */
  corch: (...args: string[]) => Promise<number | null>
}

/**
 * A data folder, a unit folder that doesn't exist yet, and a fake launchd or systemd behind the `runCommand` seam.
 * It starts and stops a fake host as the real one would, and answers `refuse` for any command starting with a key.
 */
function setup(platform: 'darwin' | 'linux', refuse: Record<string, CommandResult> = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), 'corch-service-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const unitDir = join(root, 'units', 'user')
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  let host: FakeHost | null = null
  let loaded = false
  const up = async () => {
    host ??= await fakeHost(dataDir)
  }
  const down = async () => {
    await host?.stop()
    host = null
  }
  const ok = (stdout = ''): CommandResult => ({ code: 0, out: stdout, err: '' })
  const runCommand = async (argv: string[]): Promise<CommandResult> => {
    const line = argv.join(' ')
    calls.push(line)
    const refused = Object.entries(refuse).find(([start]) => line.startsWith(start))
    if (refused) return refused[1]
    const [tool, first, second] = argv
    const verb = tool === 'systemctl' ? second : first
    switch (verb) {
      case 'print':
        return loaded ? ok(`\tstate = ${host ? 'running' : 'not running'}\n`) : { code: 113, out: '', err: '' }
      case 'is-active':
        return { code: host ? 0 : 3, out: host ? 'active\n' : 'inactive\n', err: '' }
      case 'show-user':
        return ok('Linger=no\n')
      case 'bootstrap':
        loaded = true
        await up()
        return ok()
      case 'bootout':
        loaded = false
        await down()
        return ok()
      case 'enable':
      case 'start':
        await up()
        return ok()
      case 'kickstart':
        if (argv.includes('-k')) await down()
        await up()
        return ok()
      case 'restart':
        await down()
        await up()
        return ok()
      case 'kill':
      case 'disable':
      case 'stop':
        await down()
        return ok()
      default:
        return ok()
    }
  }
  const deps = serviceDeps(
    dataDir,
    { CORCH_PORT: '4711', CORCH_LOG_LEVEL: 'debug' },
    {
      platform,
      home: join(root, 'home'),
      self: SELF,
      unitDir,
      runCommand,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  )
  const corch = (...args: string[]) => runCli([...args, '--data-dir', dataDir], deps.env, deps)
  return { dataDir, unitDir, deps, calls, out, err, host: () => host, corch }
}

const name = (dataDir: string) => serviceName(dataDir, '/nowhere')
const uid = process.getuid?.() as number

describe('corch service', () => {
  test('launchd: install loads the agent, and start, stop, restart, status and uninstall act through launchctl', async () => {
    const { dataDir, unitDir, calls, out, err, host, corch } = setup('darwin')
    const label = launchdLabel(name(dataDir))
    const plist = join(unitDir, `${label}.plist`)
    const target = `gui/${uid}/${label}`

    expect(await corch('service', 'install')).toBe(0)
    expect(calls.splice(0)).toEqual([`launchctl bootstrap gui/${uid} ${plist}`])
    expect(statSync(plist).mode & 0o777).toBe(0o644)
    expect(readdirSync(unitDir)).toEqual([`${label}.plist`])
    const text = readFileSync(plist, 'utf8')
    // The settings in the environment never reach the unit: the host reads `config.json` when it starts.
    for (const setting of [...Object.values(SETTING_FLAGS), 'CORCH_', '4711', 'debug', 'EnvironmentVariables'])
      expect([setting, text.includes(setting)]).toEqual([setting, false])
    const first = host() as FakeHost
    expect(out.splice(0)).toEqual([
      `Installed the service ${label}. corch is running at ${readRunFile(dataDir)?.record?.url} (pid ${first.pid})`,
    ])

    expect(await corch('stop')).toBe(0)
    expect(calls.splice(0)).toEqual([`launchctl kill SIGTERM ${target}`])
    expect(host()).toBeNull()
    expect(await corch('status')).toBe(3)
    expect(out.splice(0).at(-1)).toBe(`  service: ${label} (loaded, not running)`)
    expect(calls.splice(0)).toEqual([`launchctl print ${target}`])
    expect(await corch('start')).toBe(0)
    expect(calls.splice(0)).toEqual([`launchctl print ${target}`, `launchctl kickstart ${target}`])
    const second = host() as FakeHost
    expect(await corch('restart')).toBe(0)
    expect(calls.splice(0)).toEqual([`launchctl print ${target}`, `launchctl kickstart -k ${target}`])
    expect(host()?.instanceId).not.toBe(second.instanceId)
    expect(out.splice(0).at(-1)).toBe(`corch is running at ${readRunFile(dataDir)?.record?.url} (pid ${host()?.pid})`)

    for (const args of [
      ['start', '--port', '5000'],
      ['restart', '--log-level=debug'],
    ])
      expect([args, await corch(...args)]).toEqual([args, 1])
    expect(err.splice(0).join('\n')).toContain('corch config set')
    expect(calls.splice(0)).toEqual([])

    // Again, it reloads the agent and reports the new host.
    const third = host() as FakeHost
    expect(await corch('service', 'install')).toBe(0)
    expect(calls.splice(0)).toEqual([
      `launchctl print ${target}`,
      `launchctl bootout ${target}`,
      `launchctl print ${target}`,
      `launchctl bootstrap gui/${uid} ${plist}`,
    ])
    expect(host()?.instanceId).not.toBe(third.instanceId)
    expect(out.splice(0).at(-1)).toContain(`(pid ${host()?.pid})`)

    expect(await corch('service', 'uninstall')).toBe(0)
    expect(calls.splice(0)).toEqual([
      `launchctl print ${target}`,
      `launchctl bootout ${target}`,
      `launchctl print ${target}`,
    ])
    expect(existsSync(plist)).toBe(false)
    expect(out.splice(0).join('\n')).toContain('corch start runs the host without the service')
    expect(await corch('service', 'uninstall')).toBe(0)
    expect(out.splice(0)).toEqual([`No corch service is installed for ${dataDir}`])
    expect(await corch('status')).toBe(3)
    expect(out.splice(0).at(-1)).toBe('  service: not installed')
    expect(err).toEqual([])
  })

  test('systemd: install enables the unit and hints at linger; the rest act through systemctl --user', async () => {
    const { dataDir, unitDir, calls, out, host, corch } = setup('linux')
    const unit = `${name(dataDir)}.service`
    const path = join(unitDir, unit)

    expect(await corch('service', 'install')).toBe(0)
    expect(calls.splice(0)).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${unit}`,
      `loginctl show-user ${serviceDeps(dataDir, {}).user} -p Linger`,
    ])
    expect(statSync(path).mode & 0o777).toBe(0o644)
    const text = readFileSync(path, 'utf8')
    expect(execStartArgs(unitValues(text, 'ExecStart')[0] as string)).toEqual([
      ...SELF,
      'run',
      '--background',
      '--data-dir',
      dataDir,
    ])
    for (const setting of [...Object.values(SETTING_FLAGS), 'CORCH_', '4711', 'debug', 'Environment='])
      expect([setting, text.includes(setting)]).toEqual([setting, false])
    expect(out.splice(0).join('\n')).toContain(`loginctl enable-linger ${serviceDeps(dataDir, {}).user}`)

    expect(await corch('stop')).toBe(0)
    expect(await corch('start')).toBe(0)
    const before = host()?.instanceId
    expect(await corch('restart')).toBe(0)
    expect(host()?.instanceId).not.toBe(before)
    expect(await corch('status')).toBe(0)
    expect(calls.splice(0)).toEqual([
      `systemctl --user stop ${unit}`,
      `systemctl --user start ${unit}`,
      `systemctl --user restart ${unit}`,
      `systemctl --user is-active ${unit}`,
    ])
    expect(out.at(-1)).toBe(`  service: ${unit} (active)`)

    expect(await corch('service', 'uninstall')).toBe(0)
    expect(calls.splice(0)).toEqual([`systemctl --user disable --now ${unit}`, 'systemctl --user daemon-reload'])
    expect(existsSync(path)).toBe(false)
    expect(host()).toBeNull()
  })

  test('install stops a host that runs without the service, and its shells are not touched', async () => {
    const { dataDir, out, host, corch } = setup('linux')
    mkdirSync(dataDir, { mode: 0o700 })
    const unmanaged = await fakeHost(dataDir)
    expect(await corch('service', 'install')).toBe(0)
    expect(out[0]).toBe(
      `Stopping the host that runs without the service (pid ${unmanaged.pid}); its terminals keep running.`,
    )
    expect(host()?.instanceId).not.toBe(unmanaged.instanceId)
    expect(readRunFile(dataDir)?.record?.instanceId).toBe(host()?.instanceId as string)
  })

  test('install removes the unit file and exits 1 with the manager message when the manager refuses', async () => {
    const refusals = [
      ['linux', 'systemctl --user daemon-reload', 'Failed to connect to bus: No medium found'],
      ['darwin', 'launchctl bootstrap', 'Bootstrap failed: 125: Domain does not support specified action'],
    ] as const
    for (const [platform, command, message] of refusals) {
      const { dataDir, unitDir, err, host, corch } = setup(platform, { [command]: { code: 1, out: '', err: message } })
      expect(await corch('service', 'install')).toBe(1)
      expect(readdirSync(unitDir)).toEqual([])
      expect(err.join('\n')).toContain(message)
      expect(host()).toBeNull()
      expect(existsSync(runFilePath(dataDir))).toBe(false)
    }
  })

  test('install refuses root before writing anything and never calls a command', async () => {
    const { unitDir, calls, err, deps } = setup('linux')
    expect(await runCli(['service', 'install', '--data-dir', deps.dataDir], deps.env, { ...deps, uid: 0 })).toBe(1)
    expect(err.join('\n')).toContain('never for root')
    expect(existsSync(unitDir)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('the workspaces', () => {
  test('have no install scripts, so installing a package never registers the service', () => {
    const repo = join(import.meta.dir, '../../../..')
    const manifests = [
      join(repo, 'package.json'),
      ...['apps', 'packages'].flatMap((folder) =>
        readdirSync(join(repo, folder))
          .map((name) => join(repo, folder, name, 'package.json'))
          .filter((path) => existsSync(path)),
      ),
    ]
    expect(manifests.length).toBeGreaterThan(10)
    for (const path of manifests) {
      const scripts = Object.keys(JSON.parse(readFileSync(path, 'utf8')).scripts ?? {})
      const hooks = scripts.filter((script) => ['preinstall', 'install', 'postinstall'].includes(script))
      expect([path, hooks]).toEqual([path, []])
    }
  })
})
