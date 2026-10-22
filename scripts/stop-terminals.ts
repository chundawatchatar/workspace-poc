import { resolve } from 'node:path'
import { DaemonRepository } from '../apps/host/src/modules/terminals/daemon.repository'
import { stopDaemon } from '../apps/host/src/modules/terminals/daemon.service'

const repository = new DaemonRepository(resolve(import.meta.dir, '../apps/host'))
const result = await stopDaemon(repository)
if (result === 'stopped') {
  for (const record of repository.list()) repository.remove(record.id)
  console.log('Stopped the terminal daemon and every session it owned')
} else {
  console.log('No terminal daemon was running')
}
