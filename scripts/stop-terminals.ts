import '../apps/host/src/env'
import { resolve } from 'node:path'
import { requiredEnv } from '@orch/shared/env'
import { DaemonRepository } from '../apps/host/src/modules/terminals/daemon.repository'
import { stopDaemon } from '../apps/host/src/modules/terminals/daemon.service'

const host = { hostname: requiredEnv('HOST_HOST'), port: Number(requiredEnv('HOST_PORT')) }

/** Whether a host is listening. A running host starts the daemon again for its open tabs and keeps their records. */
async function hostRunning(): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: host.hostname, port: host.port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

if (await hostRunning()) {
  console.error(
    `A host is running on port ${host.port}. Stop \`bun run dev\` first: it would start the daemon again for its open tabs.`,
  )
  process.exit(1)
}

const repository = new DaemonRepository(resolve(import.meta.dir, '../apps/host'))
const result = await stopDaemon(repository)
// Records are kept: the next host offers to resume their agents and reopens shells in their folders, and ends
// the records of terminals no longer in its layout.
if (result === 'stopped') {
  console.log('Stopped the terminal daemon and every session it owned')
} else {
  console.log('No terminal daemon was running')
}
