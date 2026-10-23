import { resolve } from 'node:path'
import { DaemonRepository } from '../apps/host/src/modules/terminals/daemon.repository'
import { stopDaemon } from '../apps/host/src/modules/terminals/daemon.service'
import { HOST_PORT } from '../packages/shared/src'

/** Whether a host is listening. A running host starts the daemon again for its open tabs and keeps their records. */
async function hostRunning(): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port: HOST_PORT, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

if (await hostRunning()) {
  console.error(
    `A host is running on port ${HOST_PORT}. Stop \`bun run dev\` first: it would start the daemon again for its open tabs.`,
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
