import { DAEMON_SUBCOMMAND } from './modules/terminals/daemon-build'

// The host executable's one entry point, the file a packaging step compiles. With the daemon subcommand it runs the
// terminal daemon, so a compiled host can start the daemon from itself; that path never imports `./env`, which loads
// the root `.env`, or `./index`. Anything else starts the host.
if (process.argv[2] === DAEMON_SUBCOMMAND) {
  const { runDaemon } = await import('@orch/ptyd-bun/daemon')
  await runDaemon(process.argv)
} else {
  await import('./index')
}
