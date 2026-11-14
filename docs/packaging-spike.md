# Packaging spike: the host and the daemon as compiled executables

This records where today's code breaks when the host (`apps/host/src/index.ts`) and the terminal daemon
(`apps/ptyd-bun/src/main.ts`) run as `bun build --compile` executables outside the repo. No product code was changed
to get further. Each finding names the backlog job under "Installable host (`corch`)" in `factory/backlog.md` that
fixes it, quoted by its first words. It is written for whoever builds those jobs; the sprint's last job ("Docs:
describe installing and running `corch`") folds it into the other docs.

## Environment

- Bun 1.4.0 (`bun --version`).
- macOS 27.2 (build 26B123), Apple silicon (`darwin-arm64`). Linux was not tried; only the current platform is built.
- Built from commit `20788c6` (`main` at the time) plus this spike's build script.

## Build

```sh
bun install
bun run spike:compile
```

`scripts/spike-compile.ts` runs, from the repo root:

```sh
bun build --compile apps/host/src/index.ts --outfile dist/spike/orch-host
bun build --compile apps/ptyd-bun/src/main.ts --outfile dist/spike/orch-ptyd
```

It keeps Bun's defaults on purpose (no `--no-compile-autoload-*` flags, no `--asset`), reads no `.env` and fails only
when a build fails. Both build cleanly: 240 modules for the host and 140 for the daemon, with no warnings and nothing
left external. Each executable is about 65 MB. `dist/` is gitignored, so `git status --porcelain` stays empty.

## Running outside the repo

Every step below runs outside the repo. `$RUN` is any empty temporary folder, for example `RUN=$(mktemp -d)`.

1. Copy the binaries out and re-sign them (see finding 1; without this macOS kills both at once with exit 137):

   ```sh
   cp dist/spike/orch-host dist/spike/orch-ptyd "$RUN/"
   cd "$RUN"
   codesign --force --sign - orch-host orch-ptyd
   ```

2. Put a conflicting `.env` and a `bunfig.toml` with a preload in that folder. The `.env` values would be refused or
   would show up if they were read; the preload prints a line if Bun runs it:

   ```sh
   printf 'HOST_HOST=0.0.0.0\nHOST_PORT=1\nSPIKE_DOTENV=from-cwd-env\nORCH_PTY_RUNTIME=%s/runtime-from-dotenv\n' "$RUN" > .env
   printf 'preload = ["./spike-preload.ts"]\n' > bunfig.toml
   printf 'console.log("SPIKE: bunfig preload ran")\n' > spike-preload.ts
   ```

3. Start the host with that folder as the working directory, a clean environment and a temporary port, so the dev
   host's `.data` and port are untouched:

   ```sh
   env -i HOME="$HOME" PATH=/usr/bin:/bin SHELL=/bin/zsh HOST_HOST=127.0.0.1 HOST_PORT=4791 ./orch-host
   ```

   It prints `SPIKE: bunfig preload ran`, then exits 1 with `EROFS: read-only file system, mkdir '/$bunfs'` (finding
   3). It never listens, and it starts no daemon.

4. Start the daemon on its own, with a private socket folder:

   ```sh
   mkdir -m 700 sock
   env -i HOME="$HOME" PATH=/usr/bin:/bin SHELL=/bin/zsh ./orch-ptyd --socket "$RUN/sock/host.sock"
   ```

   It prints the preload line and keeps running. It creates `sock/host.sock`, `sock/agent.sock` and the shim folder
   `sock/agent/`.

5. From another terminal in the repo, talk to it with a short Bun script that imports `DAEMON_PROTOCOL`,
   `DaemonDecoder` and `encodeControlFrame` from `packages/terminal/src/index.ts`: send a `hello` (`protocol`, an id, a
   32-character token, `cwd`, `cols`, `rows`), then an `input` such as `echo ok; exit\r`, print the `status` frames
   and the output, then send `{ "type": "stop" }`. The daemon answers with `alive: true` and a shell pid, runs the
   input, reports the shell's exit, and exits on `stop`. Check that nothing is left with `pgrep -fl orch-ptyd`.

6. To test Bun's own autoload apart from the host, compile a one-line probe in `$RUN`
   (`console.log(process.env.SPIKE_DOTENV)`) with and without `--no-compile-autoload-dotenv
   --no-compile-autoload-bunfig`, re-sign it, and run it there (finding 10).

7. Clean up: `rm -rf "$RUN"`. The host never got far enough to make `/tmp/orchpty-*` or a `.data` folder.

## Findings

| # | Item | Result | Fixed by |
| --- | --- | --- | --- |
| 1 | Code signature on macOS | breaks | no job yet |
| 2 | `hostRoot` / `projectRoot` from `import.meta.dir` | breaks | "Host: make the data folder a setting" |
| 3 | `.data` paths under `hostRoot` | breaks | "Host: make the data folder a setting" |
| 4 | `rootEnvPath` and `loadRootEnv()` | depends on the repo | "Host: add the `corch` lifecycle commands" |
| 5 | `daemonBuild()` reading `.ts` files | breaks in the host, works in the daemon | "Host and daemon: run the terminal daemon…" |
| 6 | Daemon started as `process.execPath` + `main.ts` | breaks | "Host and daemon: run the terminal daemon…" |
| 7 | Agent hook shims | works | "Host and daemon: run the terminal daemon…" |
| 8 | The UI's build-time host URL; UI not served | depends on the repo | "Host and web: serve the built local UI" |
| 9 | Native or optional dependencies | works | none needed |
| 10 | `.env` and `bunfig.toml` autoload in the working folder | breaks | "Host: add the `corch` lifecycle commands" |
| 11 | Embedded files | works | "Build: compile `corch`…" for the UI |
| 12 | Daemon runtime folder shared by every compiled host | breaks | "Host: make the data folder a setting" |

### 1. The compiled executables have an invalid code signature on macOS

- Observed: both binaries, and a one-line probe built the same way, are killed by the kernel at start-up with exit
  137 and no output, run in place in `dist/spike/` or copied elsewhere. `codesign -v --verbose=2 orch-host` says
  `invalid signature (code or signature have been modified)`; `codesign -dv` shows an ad-hoc, linker-signed
  signature. `codesign --force --sign - <binary>` fixes it, after which the binary runs.
- Cause: Bun 1.4.0's `--compile` output on this macOS version, not this repo's code (`scripts/spike-compile.ts`
  only calls `bun build --compile`). It may be specific to this Bun and macOS pair.
- Fixed by: no job yet. It belongs in "Build: compile `corch` with `bun build --compile` for darwin-arm64…": the
  packaging build must re-sign each darwin binary (ad hoc, or with a real identity for notarization) and its smoke
  test catches a binary that won't start. The spike build leaves this to that job.

### 2. `hostRoot` and `projectRoot` from `import.meta.dir`

- Observed: inside a compiled binary `import.meta.dir` is `/$bunfs/root` (seen with a probe), so `hostRoot` is
  `/$bunfs` and `projectRoot` is `/`. `projectRoot` goes into `HostInfo` and the layout repository, so a packaged
  host would report `/` as the project folder.
- Cause: `apps/host/src/index.ts:27-28`, `apps/host/src/rotate-key.ts:20` and `apps/host/src/remote.ts:31`
  (`resolve(import.meta.dir, '..')`). Only `index.ts` was compiled; the other two derive their paths the same way,
  from reading the code.
- Fixed by: "Host: make the data folder a setting" (nothing resolves data paths from `import.meta.dir`), with
  `rotate-key` and `remote` folded in by "Host: add the `corch` lifecycle commands" (`corch remote …`,
  `corch rotate-key`). `projectRoot` has no job of its own; the data-folder job should decide what replaces it (the
  home folder, probably).

### 3. The `.data` paths under `hostRoot`

- Observed: the host exits 1 at start-up:

  ```text
  EROFS: read-only file system, mkdir '/$bunfs'
        at new DaemonRepository (/$bunfs/root/orch-host:32484:17)
        at daemonFactory (/$bunfs/root/orch-host:32697:22)
  ```

  This is the first write: `mkdirSync('/$bunfs/.data/terminal-daemons')`. The layout and agent-tracking
  repositories are built before it but only check `existsSync`, which finds nothing. Every other `.data` file
  (`state.json`, `agent-tracking.json`, `remote-access.json`, `linked-account.json`, `devices.json`,
  `remote-audit.jsonl`, `machine-key`, `access-keys.json`) is not reached; from reading the code, each would read as
  missing and then fail the same way on its first write.
- Cause: `apps/host/src/modules/terminals/daemon.repository.ts:48,52-53`, and the path helpers that join
  `hostRoot` with `.data`: `layout.repository.ts:51`, `agent-tracking.repository.ts:21`, `access.repository.ts:23`,
  `audit-log.repository.ts:12`, `devices.repository.ts:15`, `linked-account.repository.ts:21`,
  `remote-access.repository.ts:18`, `tunnel.repository.ts:7`.
- Fixed by: "Host: make the data folder a setting".

### 4. `rootEnvPath` and `loadRootEnv()`

- Observed: in a compiled probe that imports `@orch/shared/env`, `rootEnvPath` is `/.env`, since `import.meta.url`
  points into `/$bunfs/root/` and `../../../.env` climbs to the file system root. So the packaged host never reaches
  the repo's `.env`; it would read a `/.env` if one existed (none does here). The compiled host runs
  `loadRootEnv()` first (`apps/host/src/env.ts:4`, imported by `index.ts:1`), before the crash in finding 3.
- Cause: `packages/shared/src/env.ts:11`, called from `apps/host/src/env.ts:4`.
- Result: depends on the repo. Fixed by: "Host: add the `corch` lifecycle commands" (packaged entry points don't
  import `apps/host/src/env.ts`), with "Host: load the packaged host's settings" replacing the `.env` settings.

### 5. `daemonBuild()` reading `.ts` files

- In the compiled daemon it works but means something else: `daemonBuild(import.meta.path)`
  (`apps/ptyd-bun/src/main.ts:52`) hashes `/$bunfs/root/orch-ptyd`, the embedded bundle, and
  `readdirSync('/$bunfs/root')` finds no `.ts` sources. The daemon reported build `7958948ab41cb089`, while the same
  call on the source files gives `22ed3c1e52c8661d`, so a host run from source always calls a compiled daemon
  "different code", and the other way round.
- In the compiled host it breaks, not reached, from reading the code: `SharedDaemon` calls
  `daemonBuild('/ptyd-bun/src/main.ts')` (the last element of the command in finding 6) and `readFileSync` throws
  `ENOENT` in its constructor, right after the crash in finding 3.
- Cause: `packages/terminal/src/daemon-protocol.ts:58-65`, called from `apps/ptyd-bun/src/main.ts:52` and
  `apps/host/src/modules/terminals/shared-daemon.service.ts:28`.
- Fixed by: "Host and daemon: run the terminal daemon and the agent hook shims from the host's own executable"
  (a build id embedded when packaging, the source hash kept in dev).

### 6. The daemon started as `process.execPath` + `../ptyd-bun/src/main.ts`

- Observed: not reached, from reading the code. In a compiled host `process.execPath` is the host binary itself
  (seen with a probe) and the script path is `/ptyd-bun/src/main.ts`. A compiled executable treats its arguments as
  its own `argv` and does not run a script given to it (a probe started as `./probe ./other.ts --socket x` ran its
  own code, not `other.ts`), so the spawn would start a second copy of the host with
  `--socket` and `--shell` arguments it ignores, not a daemon. Even if that were fixed, the source file is not
  there outside the repo.
- Cause: `apps/host/src/modules/terminals/daemon.service.ts:122`, spawned at `shared-daemon.service.ts:96`.
- Fixed by: "Host and daemon: run the terminal daemon and the agent hook shims from the host's own executable"
  (an internal subcommand).

### 7. The agent hook shims

- Observed: the shims are not started by path from the repo. The daemon writes them as shell scripts into its
  runtime folder at start-up (`<runtime>/agent/bin/orch-agent-hook`, `claude`, `codex`, the zsh wrapper files in
  `<runtime>/agent/zsh/` and `claude-settings.json`), from strings compiled into the daemon. The compiled daemon
  wrote all of them into `$RUN/sock/agent/`. They need `/bin/sh` and `curl` only (the hook posts to `agent.sock`
  with `curl --unix-socket`); none of them names Bun, `node` or a repo path.
- Cause: `packages/terminal/src/agent-shim.ts:95-111` (`writeAgentShim`), `agent-shim-base.ts:9` and
  `:44-46` (`curl`), called from `apps/ptyd-bun/src/main.ts:469`. The `agent-shim-*.ts` files are TypeScript
  modules that hold the script text, not programs.
- Result: works. The job "Host and daemon: run the terminal daemon and the agent hook shims from the host's own
  executable" assumes they are started by path; it can drop that part, or keep them as scripts and only make sure
  the packaged daemon still writes them. `curl` stays a runtime requirement of agent tracking.

### 8. The UI's build-time host URL, and the UI not being served

- Observed, from reading the code: the web app's host address is fixed when Vite builds it, from `HOST_HOST` and
  `HOST_PORT` in the repo's `.env`, so a built UI only talks to the port it was built for. The compiled host does
  not serve the UI at all: it has no static route, and nothing of `apps/web` is in its bundle.
- Cause: `apps/web/vite.config.ts:12` (`define` of `import.meta.env.VITE_HOST_URL`) and
  `apps/web/src/routes/__root.tsx:15` (`createLocalTransport(import.meta.env.VITE_HOST_URL)`).
- Result: depends on the repo. Fixed by: "Host and web: serve the built local UI".

### 9. Native or optional dependencies

- Observed: none. The host and daemon depend only on `hono`, `@hono/bun`, `zod`, `@xterm/headless` and
  `@xterm/addon-serialize`, all plain JavaScript. The PTY is Bun's built-in `terminal` option of `Bun.spawn`
  (`packages/terminal/src/core.ts:432-435`), which works in the compiled daemon: the shell started, ran its input and
  reported its exit. Nothing uses `bun:ffi`, `bun:sqlite`, a `.node` addon or a dynamic `import()`, and the bundler
  kept nothing external. At runtime the host still runs `git` (`apps/host/src/modules/git/git.service.ts:6`) and
  `ps`-style process listing (`packages/terminal/src/processes.ts:89`) from `PATH`, as it does today.
- Result: works. Fixed by: none needed.

### 10. `.env` and `bunfig.toml` autoload in the working folder

- Observed: Bun 1.4.0 turns both autoloads on by default in compiled executables (`bun build --help`:
  `--compile-autoload-dotenv` and `--compile-autoload-bunfig`, both "default: true"). With the files from step 2:
  - Both `orch-host` and `orch-ptyd` printed `SPIKE: bunfig preload ran`: a `bunfig.toml` preload in the working
    folder runs its code inside the binary before the entry point.
  - The probe printed `from-cwd-env`, so a `.env` in the working folder is loaded. A variable set in the
    environment still wins (`SPIKE_DOTENV=from-env` printed `from-env`), so the `HOST_*` values passed in step 3 were
    not overridden, but any setting left out of the environment is taken from the folder's `.env`. Run from a
    subfolder without one, the probe printed `undefined`: only the working folder is read.
  - Built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, the probe ran neither the preload nor
    read the `.env`. The spike build doesn't pass these flags; the packaging job decides. `--compile-autoload-tsconfig`
    and `--compile-autoload-package-json` are already off by default.
- Cause: Bun's compile defaults, used by `scripts/spike-compile.ts`.
- Result: breaks (a folder's `bunfig.toml` can run code in the host). Fixed by: "Host: add the `corch` lifecycle
  commands" (no packaged command loads a `.env` or `bunfig.toml`, with a test from a folder holding a conflicting
  `.env`), and the flags belong in "Build: compile `corch` with `bun build --compile`…".

### 11. Embedded files

- Observed: no product file is read from disk at runtime except the settings and state in `.data` (finding 3),
  `.env` (finding 4) and the daemon's own source for `daemonBuild()` (finding 5). The shims are generated, not read
  (finding 7). `readFileSync` elsewhere reads user data: agent session files under the home folder
  (`packages/terminal/src/agents.ts:137`) and the daemon records. So the host and daemon need no `--asset` today;
  the built web UI will be the first embedded folder.
- Result: works. Fixed by: "Build: compile `corch` with `bun build --compile`…" (embeds the UI), with "Host and
  web: serve the built local UI" serving it.

### 12. The daemon runtime folder is the same for every compiled host

- Observed: not reached, from reading the code. The runtime folder is `/tmp/orchpty-<uid>-<hash of hostRoot>`, and
  `hostRoot` is the constant `/$bunfs` in every compiled host, so every packaged host on the machine for one user
  would share one daemon socket, wherever it is installed. `ORCH_PTY_RUNTIME` overrides it, and can also come from a
  working folder's `.env` (finding 10).
- Cause: `apps/host/src/modules/terminals/daemon.repository.ts:49-50`.
- Fixed by: "Host: make the data folder a setting" (the daemon runtime folder is in its list).

## Not covered

- Linux, x64, cross-compiling and npm packaging (later jobs).
- `rotate-key.ts` and `remote.ts` were not compiled; finding 2 covers them from reading the code.
- Anything after the host's crash at start-up (HTTP routes, sockets, the tunnel) was not observed in a compiled host.
