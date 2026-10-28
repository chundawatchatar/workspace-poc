import { resolve } from 'node:path'
import { buildRequest, HOST_PORT, type RotateAccessResponse, rotateAccessResponse, routes } from '@orch/shared'
import { AccessKeyRepository, accessKeysPath } from './modules/access/access.repository'
import {
  AccessKeys,
  clientUrlFromServerUrl,
  machineIdFromSecret,
  parseClientUrl,
  rotateAccess,
} from './modules/access/access.service'
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
  // 409: the host runs without `SERVER_URL`, so the file is rotated for its next start.
  if (response.status === 409) return null
  if (!response.ok) throw new Error(`the host refused to rotate the key (${response.status})`)
  return rotateAccessResponse.parse(await response.json())
}

/** Rotates `access-keys.json` directly, for a host that is not running. */
function rotateFile(): RotateAccessResponse {
  const secret = loadOrCreateMachineSecret(machineSecretFile(hostRoot))
  const keys = new AccessKeys(new AccessKeyRepository(accessKeysPath(hostRoot)))
  const fromEnv = process.env.CLIENT_URL ? parseClientUrl(process.env.CLIENT_URL) : null
  const clientUrl = fromEnv ?? (process.env.SERVER_URL ? clientUrlFromServerUrl(process.env.SERVER_URL) : null)
  return rotateAccess({ keys, machineId: machineIdFromSecret(secret), clientUrl })
}

try {
  const throughHost = await rotateThroughHost()
  const result = throughHost ?? rotateFile()
  console.log(
    throughHost
      ? 'Access key rotated. Sessions that used the old key were closed.'
      : 'Access key rotated. The host was not serving remote access; it uses this key from its next start with SERVER_URL.',
  )
  console.log(
    result.link ? `Connect link: ${result.link}` : `Machine id: ${result.machineId}\nAccess key: ${result.key}`,
  )
  console.log('It will not be shown again.')
} catch (error) {
  console.error(`rotating the key failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
