import { DAEMON_SUBCOMMAND } from './modules/terminals/daemon-build'

// The host executable's one entry point, the file a packaging step compiles. With the daemon subcommand it runs the
// terminal daemon, so a compiled host can start the daemon from itself. A packaged process, one with a build id
// compiled in, runs the `corch` command; anything else is the dev host. Neither of the first two imports `./env`,
// which loads the root `.env`, or `./index`.
if (process.argv[2] === DAEMON_SUBCOMMAND) {
  const { runDaemon } = await import('@orch/ptyd-bun/daemon')
  await runDaemon(process.argv)
} else {
  const { embeddedBuildId } = await import('@orch/terminal')
  if (embeddedBuildId() !== null) {
    const { runCli } = await import('./cli/cli')
    const code = await runCli(process.argv.slice(2))
    if (code !== null) process.exitCode = code
  } else {
    await import('./index')
  }
}
