import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { writeAgentShim } from './agent-shim'

// The scripts run with `/bin/sh` against fake binaries and a fake socket server, never a real Codex or network.

const TOKEN = 'ab'.repeat(32)
const JSON_ARGUMENT = '{"type":"agent-turn-complete","input-messages":["SECRET-PROMPT"]}'
const ACCEPTED = () => Response.json({ claude: false, codex: true })
const APPROVALS = [
  '-c',
  'tui.notifications=["approval-requested"]',
  '-c',
  'tui.notification_method="bel"',
  '-c',
  'tui.notification_condition="always"',
]
const QUIET = { stdout: '', stderr: '', code: 0 }

let root: string
let runtime: string
let bin: string
let fakes: string
let home: string
let project: string
let log: string
let socket: string
let servers: { stop(force: boolean): unknown }[]

beforeEach(() => {
  // Not `tmpdir()`: on macOS its path can be too long for a Unix socket. `realpath`, because the shim resolves its folder.
  root = realpathSync(mkdtempSync('/tmp/orch-codex-'))
  runtime = join(root, 'run')
  mkdirSync(runtime)
  bin = writeAgentShim(runtime)
  fakes = join(root, 'fakes')
  home = join(root, 'home')
  project = join(root, 'project')
  for (const dir of [fakes, home, project]) mkdirSync(dir)
  log = join(root, 'log')
  socket = join(runtime, 'agent.sock')
  servers = []
  fakeCodex('--config')
})

afterEach(() => {
  for (const server of servers) server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function program(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o700)
}

/** A `codex` that records its arguments, pid and session variables, and whose `--help` lists `flag`. */
function fakeCodex(flag: string) {
  program(
    join(fakes, 'codex'),
    `case "$1" in --help) echo '  ${flag} <key=value>'; exit 0 ;; esac
{ echo "pid=$$ shimmed=[$ORCH_AGENT_SHIMMED] token=[$ORCH_AGENT_TOKEN] socket=[$ORCH_AGENT_SOCKET]"
for arg do echo "arg=[$arg]"; done; } >>"${log}"`,
  )
}

function serve(respond: () => Response | Promise<Response> = ACCEPTED) {
  const seen: { method: string; path: string; auth: string | null; body: string }[] = []
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

async function run(file: string, args: string[], env: Record<string, string> = {}, cwd = project) {
  const proc = Bun.spawn([file, ...args], {
    env: { PATH: `${bin}:${fakes}:/usr/bin:/bin`, HOME: home, ...env },
    cwd,
    stdin: 'ignore',
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
const codex = (args: string[], env: Record<string, string> = channel(), cwd?: string) =>
  run(join(bin, 'codex'), args, env, cwd)
const hook = (args: string[], env: Record<string, string> = channel()) =>
  run(join(bin, 'orch-agent-hook'), ['codex', ...args], env)
const hookPath = () => join(bin, 'orch-agent-hook')
const notifyValue = (elements = '') => `notify=["${hookPath()}","codex"${elements && `,${elements}`}]`
const received = () => [...readFileSync(log, 'utf8').matchAll(/^arg=\[(.*)\]$/gm)].map(([, value]) => value ?? '')

function config(contents: string) {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), contents)
}

/** Checks the shim ran the real binary with exactly `args`, and nothing of its own. */
async function expectPassThrough(args: string[], env?: Record<string, string>, cwd?: string) {
  rmSync(log, { force: true })
  await codex(args, env, cwd)
  expect(received()).toEqual(args)
  expect(readFileSync(log, 'utf8')).toContain('shimmed=[]')
}

/** Checks the shim attached to the config, and read `elements` from it. */
async function expectAttached(args: string[], elements = '', tui = APPROVALS) {
  rmSync(log, { force: true })
  await codex(args)
  expect(received()).toEqual(['-c', notifyValue(elements), ...tui, ...args])
}

describe('orch-agent-hook codex', () => {
  test('sends one fixed event, whatever the argument holds, with no token on a command line', async () => {
    const seen = serve(() => new Response(null, { status: 204 }))
    for (const argument of [JSON_ARGUMENT, '{not json SECRET-PROMPT', '']) {
      seen.length = 0
      expect(await hook([argument])).toMatchObject(QUIET)
      expect(seen).toEqual([
        {
          method: 'POST',
          path: '/v1/state',
          auth: `Bearer ${TOKEN}`,
          body: JSON.stringify({ agent: 'codex', state: 'idle', reason: 'finished' }),
        },
      ])
    }

    program(join(fakes, 'curl'), `for arg do echo "$arg"; done >"${log}"\ncat >/dev/null`)
    await hook([JSON_ARGUMENT], { ...channel(), PATH: `${fakes}:/usr/bin:/bin` })
    expect(readFileSync(log, 'utf8')).toContain('--unix-socket')
    expect(readFileSync(log, 'utf8')).not.toContain(TOKEN)
    expect(readFileSync(log, 'utf8')).not.toContain('SECRET-PROMPT')
  })

  test('stays silent and exits 0 whatever happens to the channel', async () => {
    expect(await hook([JSON_ARGUMENT], {})).toMatchObject(QUIET)
    expect(await hook([JSON_ARGUMENT])).toMatchObject(QUIET)
    expect(await hook([JSON_ARGUMENT], { ...channel(), PATH: fakes })).toMatchObject(QUIET)
    for (const status of [401, 500]) {
      serve(() => Response.json({ error: 'nope' }, { status }))
      expect(await hook([JSON_ARGUMENT])).toMatchObject(QUIET)
      servers.pop()?.stop(true)
    }
  })

  test('runs the user program once with its own arguments and the JSON, without the session variables', async () => {
    const seen = serve(() => new Response(null, { status: 204 }))
    const dir = join(root, 'a dir')
    mkdirSync(dir)
    const mine = join(dir, 'My App')
    program(
      mine,
      `{ echo "run [$ORCH_AGENT_TOKEN][$ORCH_AGENT_SOCKET][$ORCH_AGENT_SHIMMED]"
for arg do echo "arg=[$arg]"; done; } >>"${log}"`,
    )
    const user = [mine, 'turn ended', '']
    const env = { ...channel(), ORCH_AGENT_SHIMMED: '1' }
    expect(await hook([...user, JSON_ARGUMENT], env)).toMatchObject(QUIET)
    expect(seen).toHaveLength(1)
    expect(readFileSync(log, 'utf8').split('\n').slice(0, -1)).toEqual([
      'run [][][]',
      'arg=[turn ended]',
      'arg=[]',
      `arg=[${JSON_ARGUMENT}]`,
    ])
    servers.pop()?.stop(true)

    // A dead channel, then one that never answers.
    rmSync(log)
    await hook([mine, JSON_ARGUMENT])
    expect(readFileSync(log, 'utf8')).toContain('run [][][]')
    rmSync(log)
    serve(() => new Promise<Response>(() => {}))
    const stuck = await hook([mine, JSON_ARGUMENT])
    expect(stuck).toMatchObject(QUIET)
    expect(stuck.ms).toBeLessThan(1800)
    expect(readFileSync(log, 'utf8')).toContain('run [][][]')
  })

  test('hides a user program that fails or does not exist', async () => {
    const failing = join(fakes, 'failing')
    program(failing, 'echo out; echo err >&2; exit 3')
    expect(await hook([failing, JSON_ARGUMENT])).toMatchObject(QUIET)
    expect(await hook([join(root, 'missing'), JSON_ARGUMENT])).toMatchObject(QUIET)
  })
})

describe('codex shim', () => {
  test('adds notify and the approval flags, keeps the arguments as they are and becomes the agent', async () => {
    serve()
    const args = ['exec', 'two words', '', '--model=a b']
    const { pid } = await codex(args)
    expect(readFileSync(log, 'utf8').split('\n').slice(0, 1)).toEqual([
      `pid=${pid} shimmed=[1] token=[${TOKEN}] socket=[${socket}]`,
    ])
    expect(received()).toEqual(['-c', notifyValue(), ...APPROVALS, ...args])

    config('model = "x"\n[tui]\ntheme = "dark"\n')
    await expectAttached(args)
    config('notify = ["/a dir/My App", "turn-ended"]\n')
    await expectAttached(args, '"/a dir/My App", "turn-ended"')
  })

  test('takes notify only from the one exact form, and reads a CODEX_HOME config', async () => {
    serve()
    const attached: [contents: string, elements: string][] = [
      ['  notify=["a"]  \n', '"a"'],
      [`notify = ['/b c', "d#e]"]`, `'/b c', "d#e]"`],
      ['notify = []\n', ''],
      // Comments, and a path or a longer name that only contains the word, are not keys.
      ['# notify = ["old"]\nnotifier = 1\n[projects."/work/notify"]\ntrust_level = "trusted"\n', ''],
    ]
    for (const [contents, elements] of attached) {
      config(contents)
      await expectAttached([], elements)
    }

    const refused = [
      '[table]\nnotify = ["a"]\n',
      '[notify]\nx = 1\n',
      '"notify" = ["a"]\n',
      'notify = ["a"]\nnotify = ["b"]\n',
      'notify = [\n  "a",\n]\n',
      'notify = ["a"] # mine\n',
      'notify = ["a"] # [x]\n',
      'notify = ["a\\"b"]\n',
      'notify = "a"\n',
      'notify.a = 1\n',
      'x = { notify = 1 }\n',
      'x = """\nnotify = ["a"]\n"""\n',
    ]
    for (const contents of refused) {
      config(contents)
      await expectPassThrough(['x'])
    }

    config('notify = ["ignored"]\n')
    const codexHome = join(root, 'elsewhere')
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), 'notify = ["chosen"]\n')
    rmSync(log, { force: true })
    await codex([], { ...channel(), CODEX_HOME: codexHome })
    expect(received()[1]).toBe(notifyValue('"chosen"'))
  })

  test('leaves the approval flags out when the config has its own, and keeps notify', async () => {
    serve()
    for (const key of ['notifications', 'notification_method', 'notification_condition']) {
      config(`[tui]\n${key} = true\n`)
      await expectAttached(['x'], '', [])
    }
    config('tui.notifications = true\nnotify = ["a"]\n')
    await expectAttached(['x'], '"a"', [])
  })

  test('writes nothing to the user or project settings, and the hook neither', async () => {
    serve()
    const files = [
      join(home, '.codex/config.toml'),
      join(home, '.codex/hooks.json'),
      join(project, '.codex/hooks.json'),
    ]
    const contents = 'notify = ["/a dir/My App", "turn-ended"]\n'
    for (const file of files) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, contents)
    }
    const list = () => [home, project].flatMap((dir) => readdirSync(dir, { recursive: true }).map(String).sort())
    const before = list()
    await codex([])
    await hook([JSON_ARGUMENT])
    expect(list()).toEqual(before)
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  test('runs the real binary alone when the session or the binary is not right', async () => {
    const args = ['a b', '']
    await expectPassThrough(args, {})
    await expectPassThrough(args)

    serve(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expectPassThrough(args)
    servers.pop()?.stop(true)

    serve(() => Response.json({ claude: true, codex: false }))
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

    fakeCodex('--print')
    await expectPassThrough(args)
  })

  test('runs the real binary alone when something could choose another notify', async () => {
    serve()
    for (const args of [
      ['-c', 'notify=x'],
      ['--config', 'notify=x'],
      ['--config=notify=x'],
      ['-c', 'notify = x'],
      ['-cnotify=x'],
      ['-p', 'mine'],
      ['--profile', 'mine'],
      ['--profile=mine'],
      ['-C', '/tmp'],
      ['--cd=/tmp'],
      ['--remote', 'ws://127.0.0.1:1'],
      ['--remote=ws://127.0.0.1:1'],
    ]) {
      await expectPassThrough(args)
    }
    await expectAttached(['-c', 'model="x"'])

    config('notify = ["a"]\n')
    chmodSync(join(home, '.codex', 'config.toml'), 0)
    await expectPassThrough(['x'])
    rmSync(join(home, '.codex'), { recursive: true })

    const below = join(project, 'below')
    mkdirSync(join(project, '.codex'))
    mkdirSync(below)
    writeFileSync(join(project, '.codex', 'config.toml'), 'notify = ["theirs"]\n')
    await expectPassThrough(['x'], undefined, below)
    writeFileSync(join(project, '.codex', 'config.toml'), '# notify = ["theirs"]\n')
    await codex(['x'], undefined, below)
    expect(received()).toContain(notifyValue())
  })

  test('passes through when the runtime path can not go into the value', async () => {
    serve()
    for (const name of ['with"quote', 'with\\slash']) {
      const other = join(root, name)
      mkdirSync(other)
      const shim = writeAgentShim(other)
      rmSync(log, { force: true })
      await run(join(shim, 'codex'), ['x'], { ...channel(), PATH: `${shim}:${fakes}:/usr/bin:/bin` })
      expect(received()).toEqual(['x'])
    }
  })

  test('a nested agent gets no token, a missing binary reads like a shell error, and it looks past itself', async () => {
    const { pid } = await codex(['x'], { ...channel(), ORCH_AGENT_SHIMMED: '1' })
    expect(readFileSync(log, 'utf8')).toBe(`pid=${pid} shimmed=[1] token=[] socket=[]\narg=[x]\n`)

    const empty = join(root, 'empty')
    mkdirSync(empty)
    const missing = await codex([], { ...channel(), PATH: `${bin}:${empty}` })
    expect(missing.code).toBe(127)
    expect(missing.stderr).toContain('command not found')

    rmSync(log)
    const link = join(root, 'link')
    symlinkSync(bin, link)
    await codex(['x'], { PATH: [bin, link, fakes, '/usr/bin', '/bin'].join(':') })
    expect(existsSync(log)).toBe(true)
    expect(received()).toEqual(['x'])
  })
})
