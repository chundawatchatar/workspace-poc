import { resolve } from 'node:path'
import { DaemonRepository } from '../apps/host/src/modules/terminals/daemon.repository'
import { closeDaemon } from '../apps/host/src/modules/terminals/daemon.service'

const repository = new DaemonRepository(resolve(import.meta.dir, '../apps/host'))
for (const record of repository.list()) {
  const result = await closeDaemon(repository, record)
  if (result === 'closed') console.log(`Stopped terminal ${record.id}`)
  else if (result === 'stale') console.log(`Removed stale terminal record ${record.id}`)
}
