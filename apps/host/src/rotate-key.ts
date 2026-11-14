import './env'
import { buildRequest, type RotateAccessResponse, rotateAccessResponse, routes } from '@orch/shared'
import { optionalEnv } from '@orch/shared/env'
import { devDataDir, hostUrl } from './env'
import { AccessKeyRepository, accessKeysPath } from './modules/access/access.repository'
import { AccessKeys, rotateAccess } from './modules/access/access.service'
import { devAddresses, linkClientUrl } from './modules/remote-access/addresses.service'
import { migrateRemoteAccessAddresses, readSettingsFile, settingsPath } from './modules/settings/settings.repository'
import { loadSettings, SETTINGS_DEFAULTS } from './modules/settings/settings.service'
import { loadOrCreateMachineKey, machineKeyFile } from './modules/tunnel/tunnel.repository'

// `bun run host:rotate-key`: replaces the access key. A running host rotates it
// itself, so it can close the sessions of the old key; otherwise the key file is
// rotated here, for the next start.

const dataDir = devDataDir

/** The running host's answer, or null when no host with remote access answers at `HOST_HOST`:`HOST_PORT`. */
async function rotateThroughHost(): Promise<RotateAccessResponse | null> {
  const { url, body } = buildRequest(routes.access.rotate, {})
  let response: Response
  try {
    response = await fetch(`${hostUrl()}${url}`, {
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
 * is built like the host builds it at start: `CLIENT_URL` and `SERVER_URL`
 * first, then the settings file, after migrating a folder from before it. A
 * settings file that can't be used stops the rotation before any key changes.
 */
function rotateFile(): RotateAccessResponse {
  migrateRemoteAccessAddresses(dataDir)
  const settings = loadSettings({
    flags: {},
    env: {},
    file: readSettingsFile(settingsPath(dataDir)),
    defaults: SETTINGS_DEFAULTS,
  })
  const { clientUrl } = devAddresses(settings, {
    SERVER_URL: optionalEnv('SERVER_URL'),
    CLIENT_URL: optionalEnv('CLIENT_URL'),
  })
  const { machineId } = loadOrCreateMachineKey(machineKeyFile(dataDir))
  const keys = new AccessKeys(new AccessKeyRepository(accessKeysPath(dataDir)))
  return rotateAccess({ keys, machineId, clientUrl: linkClientUrl(clientUrl) })
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
