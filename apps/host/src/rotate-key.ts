import './env'
import { optionalEnv } from '@orch/shared/env'
import { devDataDir, hostUrl } from './env'
import { rotateKeyCommand } from './rotate-key-command'

// `bun run host:rotate-key`: replaces the access key, through the dev host at `HOST_HOST`:`HOST_PORT` when it runs.

process.exitCode = await rotateKeyCommand({
  dataDir: devDataDir,
  hostUrl: hostUrl(),
  env: { SERVER_URL: optionalEnv('SERVER_URL'), CLIENT_URL: optionalEnv('CLIENT_URL') },
})
