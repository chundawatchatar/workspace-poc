import './env'
import { optionalEnv } from '@orch/shared/env'
import { devDataDir, hostUrl } from './env'
import { remoteCommand } from './remote-command'

// `bun run host:remote <command>`: configures remote access from a terminal. The logic is in `remote-cli.ts`; this
// file only passes the dev host's folder, address and environment to it.

process.exitCode = await remoteCommand(process.argv.slice(2), {
  dataDir: devDataDir,
  hostUrl: hostUrl(),
  env: { SERVER_URL: optionalEnv('SERVER_URL') },
  program: 'bun run host:remote',
})
