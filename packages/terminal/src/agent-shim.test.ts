import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { agentEvent } from './agent-channel'
import { claudeSettings, writeAgentShim } from './agent-shim'
import { shellEnv } from './core'

// The scripts run with `/bin/sh` against fake binaries and a fake socket server, never a real Claude Code or network.

const TOKEN = 'ab'.repeat(32)
const ACCEPTED = () => Response.json({ claude: true, codex: false })

interface Seen {
  method: string
  path: string
  auth: string | null
  body: string
}

let root: string
let runtime: string
let bin: string
let fakes: string
let log: string
let socket: string
let servers: { stop(force: boolean): unknown }[]

beforeEach(() => {
  // Not `tmpdir()`: on macOS its path can be too long for a Unix socket. `realpath`, because the shim resolves its folder.
  root = realpathSync(mkdtempSync('/tmp/orch-shim-'))
  runtime = join(root, 'run')
  mkdirSync(runtime)
  bin = writeAgentShim(runtime)
  fakes = join(root, 'fakes')
  mkdirSync(fakes)
  log = join(root, 'log')
  socket = join(runtime, 'agent.sock')
  servers = []
  fake(
    'claude',
    `case "$1" in --help) echo '  --settings <file>'; exit 0 ;; esac
{ echo "pid=$$ shimmed=[$ORCH_AGENT_SHIMMED] token=[$ORCH_AGENT_TOKEN] socket=[$ORCH_AGENT_SOCKET]"
for arg do echo "arg=[$arg]"; done; } >>"${log}"`,
  )
})

afterEach(() => {
  for (const server of servers) server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function fake(name: string, body: string, dir = fakes) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o700)
}

function serve(respond: () => Response | Promise<Response> = ACCEPTED) {
  const seen: Seen[] = []
  const server = Bun.serve({
    unix: socket,
    development: false,
    fetch: async (request) => {
      const { pathname } = new URL(request.url)
      const body = await request.text()
      seen.push({ method: request.method, path: pathname, auth: request.headers.get('authorization'), body })
      return respond()
    },
  })
  servers.push(server)
  return seen
}

/** Runs a generated script as a shell would find it, with only the variables given. */
async function run(file: string, args: string[], env: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn([file, ...args], {
    env: { PATH: `${bin}:${fakes}:/usr/bin:/bin`, ...env },
    cwd: root,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const started = Date.now()
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { pid: proc.pid, stdout, stderr, code, ms: Date.now() - started }
}

const channel = () => ({ ORCH_AGENT_TOKEN: TOKEN, ORCH_AGENT_SOCKET: socket })
const claude = (args: string[], env: Record<string, string> = channel()) => run(join(bin, 'claude'), args, env)
const hook = (env: Record<string, string> = channel(), stdin?: string) =>
  run(join(bin, 'orch-agent-hook'), ['claude', 'working', 'prompt'], env, stdin)
const logged = () => readFileSync(log, 'utf8')

/** Checks the shim ran the real binary with exactly `args`, and nothing of its own. */
async function expectPassThrough(args: string[], env?: Record<string, string>) {
  rmSync(log, { force: true })
  await claude(args, env)
  expect(logged()).not.toContain('--settings ')
  expect([...logged().matchAll(/arg=\[.*\]/g)].map(([line]) => line)).toEqual(args.map((arg) => `arg=[${arg}]`))
  expect(logged()).toContain('shimmed=[]')
}

describe('claude-settings.json', () => {
  test('holds exactly the hooks of the design, each a literal event the channel accepts', () => {
    const settings = JSON.parse(claudeSettings())
    expect(Object.keys(settings)).toEqual(['hooks'])
    const flat = Object.entries<{ matcher?: string; hooks: Record<string, unknown>[] }[]>(settings.hooks).flatMap(
      ([event, groups]) =>
        groups.flatMap(({ matcher, hooks }) => hooks.map((hook) => [event, matcher, hook.command, hook.timeout])),
    )
    const command = (state: string, reason: string) => `orch-agent-hook claude ${state} ${reason}`
    expect(flat).toEqual([
      ['SessionStart', 'startup|resume|clear', command('idle', 'started'), 2],
      ['UserPromptSubmit', undefined, command('working', 'prompt'), 2],
      ['PreToolUse', 'AskUserQuestion', command('waiting', 'question'), 2],
      ['PreToolUse', '*', command('working', 'tool'), 2],
      ['PostToolUse', '*', command('working', 'tool'), 2],
      ['Notification', 'permission_prompt', command('waiting', 'permission'), 2],
      ['Notification', 'elicitation_dialog', command('waiting', 'question'), 2],
      ['Notification', 'idle_prompt', command('waiting', 'question'), 2],
      ['Stop', undefined, command('idle', 'finished'), 2],
      ['SessionEnd', undefined, command('idle', 'exited'), 2],
    ])
    for (const [, , line] of flat) {
      const [, agent, state, reason] = String(line).split(' ')
      expect(agentEvent.safeParse({ agent, state, reason }).success).toBe(true)
    }
    expect(claudeSettings()).not.toContain('/')
  })
})

describe('orch-agent-hook', () => {
  test('sends one fixed event, and nothing from its stdin or on a command line', async () => {
    const seen = serve(() => new Response(null, { status: 204 }))
    const result = await hook(channel(), 'SECRET-PROMPT')
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 })
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/state',
        auth: `Bearer ${TOKEN}`,
        body: JSON.stringify({ agent: 'claude', state: 'working', reason: 'prompt' }),
      },
    ])

    fake('curl', `for arg do echo "$arg"; done >"${log}"\ncat >/dev/null`)
    await run(join(bin, 'orch-agent-hook'), ['claude', 'idle', 'finished'], {
      ...channel(),
      PATH: `${fakes}:/usr/bin:/bin`,
    })
    expect(logged()).toContain('--unix-socket')
    expect(logged()).not.toContain(TOKEN)
  })

  test('stays silent and exits 0 whatever happens to the channel', async () => {
    const quiet = { stdout: '', stderr: '', code: 0 }
    expect(await hook({})).toMatchObject(quiet)
    expect(await hook()).toMatchObject(quiet)
    expect(await hook({ ...channel(), PATH: fakes })).toMatchObject(quiet)
    for (const status of [401, 500]) {
      serve(() => Response.json({ error: 'nope' }, { status }))
      expect(await hook()).toMatchObject(quiet)
      servers.pop()?.stop(true)
    }

    serve(() => new Promise<Response>(() => {}))
    const stuck = await hook()
    expect(stuck).toMatchObject(quiet)
    expect(stuck.ms).toBeLessThan(1800)
  })
})

describe('claude shim', () => {
  test('adds only --settings, keeps the arguments as they are and becomes the agent', async () => {
    serve()
    const args = ['-p', 'two words', '', '--model=a b']
    const { pid } = await claude(args)
    expect(logged().split('\n').slice(0, -1)).toEqual([
      `pid=${pid} shimmed=[1] token=[${TOKEN}] socket=[${socket}]`,
      'arg=[--settings]',
      `arg=[${join(runtime, 'agent', 'claude-settings.json')}]`,
      ...args.map((arg) => `arg=[${arg}]`),
    ])
  })

  test('leaves the user and project settings exactly as they were', async () => {
    serve(ACCEPTED)
    const home = join(root, 'home')
    const project = join(root, 'project')
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } })
    const files = [
      join(home, '.claude/settings.json'),
      join(home, '.claude.json'),
      join(project, '.claude/settings.json'),
    ]
    for (const file of files) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, settings)
    }
    const list = () => [home, project].flatMap((dir) => readdirSync(dir, { recursive: true }).map(String).sort())
    const before = list()

    const env = { ...channel(), HOME: home }
    const proc = Bun.spawn([join(bin, 'claude')], {
      cwd: project,
      env: { PATH: `${bin}:${fakes}:/usr/bin:/bin`, ...env },
    })
    await proc.exited
    await hook(env)

    expect(list()).toEqual(before)
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe(settings)
  })

  test('runs the real binary with the user arguments alone when anything is not right', async () => {
    const args = ['a b', '']
    await expectPassThrough(args, {})
    await expectPassThrough(args)

    serve(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expectPassThrough(args)
    servers.pop()?.stop(true)

    serve(() => Response.json({ claude: false, codex: true }))
    await expectPassThrough(args)
    servers.pop()?.stop(true)

    serve(async () => {
      await Bun.sleep(600)
      return ACCEPTED()
    })
    await expectPassThrough(args)
    servers.pop()?.stop(true)

    serve()
    await expectPassThrough(args, { ...channel(), PATH: `${bin}:${fakes}` })
    await expectPassThrough(args, { ...channel(), TMUX: '/tmp/tmux,1,0' })
    await expectPassThrough(args, { ...channel(), STY: '1.pts' })
    await expectPassThrough(['--settings', 'mine.json'])
    await expectPassThrough(['--settings=mine.json'])

    rmSync(join(runtime, 'agent', 'claude-settings.json'))
    await expectPassThrough(args)
  })

  test('checks each binary for the flag once, until the binary changes', async () => {
    serve()
    fake(
      'claude',
      `case "$1" in --help) echo help >>"${log}.help"; echo '  --print'; exit 0 ;; esac
for arg do echo "arg=[$arg]"; done >>"${log}"
echo "shimmed=[$ORCH_AGENT_SHIMMED]" >>"${log}"`,
    )
    await expectPassThrough(['x'])
    await expectPassThrough(['x'])
    expect(readFileSync(`${log}.help`, 'utf8')).toBe('help\n')
    expect(readdirSync(join(runtime, 'agent', 'cache'))).toHaveLength(1)

    fake(
      'claude',
      readFileSync(join(fakes, 'claude'), 'utf8').replace('--print', '--settings').replace('#!/bin/sh\n', ''),
    )
    const later = new Date(Date.now() + 5000)
    Bun.spawnSync(['touch', '-d', later.toISOString(), join(fakes, 'claude')])
    rmSync(log, { force: true })
    await claude([])
    expect(logged()).toContain('arg=[--settings]')
  })

  test('a nested agent gets no token, and a missing binary reads like a shell error', async () => {
    const { pid } = await claude(['x'], { ...channel(), ORCH_AGENT_SHIMMED: '1' })
    expect(logged()).toBe(`pid=${pid} shimmed=[1] token=[] socket=[]\narg=[x]\n`)

    const empty = join(root, 'empty')
    mkdirSync(empty)
    const missing = await claude([], { ...channel(), PATH: `${bin}:${empty}:${bin}` })
    expect(missing.code).toBe(127)
    expect(missing.stderr).toContain('command not found')
  })

  test('finds the real binary past its own folder, even when PATH reaches it twice or through a symlink', async () => {
    serve()
    const link = join(root, 'link')
    symlinkSync(bin, link)
    const twice = [bin, link, `${bin}/`, fakes, '/usr/bin', '/bin'].join(delimiter)
    await claude(['x'], { ...channel(), PATH: twice })
    expect(logged()).toContain('arg=[x]')
  })
})

describe('zsh wrapper', () => {
  const zsh = Bun.which('zsh')

  test.skipIf(!zsh)('finds the shim at the prompt without changing how the user starts up', async () => {
    const home = join(root, 'home')
    const dotdir = join(root, 'dotdir')
    const early = join(root, 'early')
    for (const dir of [home, dotdir, early]) mkdirSync(dir)
    fake('claude', 'echo fake', early)
    const marks = join(root, 'marks')
    const mark = (name: string) => `echo ${name} >>"${marks}"\n`

    const setup = (first: string, rcDir: string) => {
      rmSync(marks, { force: true })
      writeFileSync(join(home, '.zshenv'), `${mark('zshenv')}export FROM_ENV=1\n${first}`)
      writeFileSync(join(rcDir, '.zprofile'), `${mark('zprofile')}FROM_PROFILE=1\n`)
      writeFileSync(join(rcDir, '.zshrc'), `${mark('zshrc')}FROM_RC=1\nPATH="${early}:$PATH"\n`)
      writeFileSync(join(rcDir, '.zlogin'), `${mark('zlogin')}FROM_LOGIN=1\n`)
    }
    const prompt = async () => {
      const env = shellEnv(
        { HOME: home, PATH: '/usr/bin:/bin', SHELL: zsh ?? '' },
        { token: TOKEN, socket, shimDir: bin },
        zsh ?? '',
      )
      const script =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh expands these, not JavaScript.
        'print -r -- "$(whence -p claude)|${ZDOTDIR-unset}|$FROM_ENV$FROM_PROFILE$FROM_RC$FROM_LOGIN|${HISTFILE-}|${_orch_wrapper-gone}"'
      const proc = Bun.spawn([zsh ?? '', '-l', '-i', '-c', script], {
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const output = await new Response(proc.stdout).text()
      await proc.exited
      return output.trim().split('\n').at(-1)?.split('|') ?? []
    }

    setup('', home)
    const plain = await prompt()
    expect(plain.slice(0, 3)).toEqual([join(bin, 'claude'), 'unset', '1111'])
    expect(plain[3]).not.toContain(runtime)
    expect(plain[4]).toBe('gone')
    expect(readFileSync(marks, 'utf8')).toBe('zshenv\nzprofile\nzshrc\nzlogin\n')

    setup(`ZDOTDIR="${dotdir}"\n`, dotdir)
    const moved = await prompt()
    expect(moved.slice(0, 3)).toEqual([join(bin, 'claude'), dotdir, '1111'])
    expect(readFileSync(marks, 'utf8')).toBe('zshenv\nzprofile\nzshrc\nzlogin\n')
  })
})
