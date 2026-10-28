import { resolve } from 'node:path'
import { buildRequest, HOST_PORT, type RotateAccessResponse, rotateAccessResponse, routes } from '@orch/shared'
import { AccessKeyRepository, accessKeysPath } from './modules/access/access.repository'
import { AccessKeys, machineIdFromSecret, rotateAccess } from './modules/access/access.service'
import {
  RemoteAccessRepository,
  type RemoteAccessSettings,
  remoteAccessPath,
} from './modules/remote-access/remote-access.repository'
import { linkClientUrl } from './modules/remote-access/remote-access.service'
import { loadOrCreateMachineSecret, machineSecretFile } from './modules/tunnel/tunnel.repository'

// `bun run host:rotate-key`: replaces the access key. A running host rotates it
// itself, so it can close the sessions of the old key; otherwise the key file is
// rotated here, for the next start.

const hostRoot = resolve(import.meta.dir, '..')

/** The running host's answer, or null when no host with remote access answers on `HOST_PORT`. */
async function rotateThroughHost(): Promise<RotateAccessResponse | null> {
  const { url, body } = buildRequest(routes.access.rotate, {})
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${HOST_PORT}${url}`, {
      method: routes.access.rotate.method,
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch {
    return null
  }
  // 409: the host knows no server address, so the file is rotated for its next start.
  if (response.status === 409) return null
  if (!response.ok) throw new Error(`the host refused to rotate the key (${response.status})`)
  return rotateAccessResponse.parse(await response.json())
}

/**
 * Rotates `access-keys.json` directly, for a host that is not running. The link
 * is built like the host builds it: `CLIENT_URL` and `SERVER_URL` first, then
 * the saved Remote access setting.
 */
function rotateFile(): RotateAccessResponse {
  const secret = loadOrCreateMachineSecret(machineSecretFile(hostRoot))
  const keys = new AccessKeys(new AccessKeyRepository(accessKeysPath(hostRoot)))
  let saved: RemoteAccessSettings | null = null
  try {
    saved = new RemoteAccessRepository(remoteAccessPath(hostRoot)).load()
  } catch (error) {
    console.error(`ignoring the saved setting: ${error instanceof Error ? error.message : error}`)
  }
  const clientUrl = linkClientUrl({ SERVER_URL: process.env.SERVER_URL, CLIENT_URL: process.env.CLIENT_URL }, saved)
  return rotateAccess({ keys, machineId: machineIdFromSecret(secret), clientUrl })
}

try {
  const throughHost = await rotateThroughHost()
  const result = throughHost ?? rotateFile()
  console.log(
    throughHost
      ? 'Access key rotated. Sessions that used the old key were closed.'
      : 'Access key rotated. The host was not serving remote access; it uses this key once remote access is on.',
  )
  console.log(
    result.link ? `Connect link: ${result.link}` : `Machine id: ${result.machineId}\nAccess key: ${result.key}`,
  )
  console.log('It will not be shown again.')
} catch (error) {
  console.error(`rotating the key failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
