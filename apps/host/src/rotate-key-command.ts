import { buildRequest, type RotateAccessResponse, rotateAccessResponse, routes } from '@orch/shared'
import { AccessKeyRepository, accessKeysPath } from './modules/access/access.repository'
import { AccessKeys, rotateAccess } from './modules/access/access.service'
import { devAddresses, linkClientUrl, type RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { migrateRemoteAccessAddresses, readSettingsFile, settingsPath } from './modules/settings/settings.repository'
import { loadSettings, SETTINGS_DEFAULTS } from './modules/settings/settings.service'
import { loadOrCreateMachineKey, machineKeyFile } from './modules/tunnel/tunnel.repository'

// Replaces the access key. A running host rotates it itself, so it can close the sessions of the old key; otherwise
// the key file is rotated here, for the next start.

/** Where to rotate the key: the data folder, the running host's URL (null for none) and the addresses to use. */
export interface RotateKeyOptions {
  dataDir: string
  hostUrl: string | null
  /** The dev host's `SERVER_URL` and `CLIENT_URL`, on top of the settings. */
  env: RemoteAccessEnv
  /** The environment to read the `CORCH_*` settings from; the dev host reads none. */
  settingsEnv?: Record<string, string | undefined>
}

/** The running host's answer, or null when no host with remote access answers at `hostUrl`. */
async function rotateThroughHost(hostUrl: string | null): Promise<RotateAccessResponse | null> {
  if (hostUrl === null) return null
  const { url, body } = buildRequest(routes.access.rotate, {})
  let response: Response
  try {
    response = await fetch(`${hostUrl}${url}`, {
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
 * Rotates `access-keys.json` directly, for a host that is not running. The link is built like the host builds it
 * at start: `CLIENT_URL` and `SERVER_URL` first, then the settings, after migrating a folder from before the
 * settings file. A settings file that can't be used stops the rotation before any key changes.
 */
function rotateFile({ dataDir, env, settingsEnv = {} }: RotateKeyOptions): RotateAccessResponse {
  migrateRemoteAccessAddresses(dataDir)
  const settings = loadSettings({
    flags: {},
    env: settingsEnv,
    file: readSettingsFile(settingsPath(dataDir)),
    defaults: SETTINGS_DEFAULTS,
  })
  const { clientUrl } = devAddresses(settings, env)
  const { machineId } = loadOrCreateMachineKey(machineKeyFile(dataDir))
  const keys = new AccessKeys(new AccessKeyRepository(accessKeysPath(dataDir)))
  return rotateAccess({ keys, machineId, clientUrl: linkClientUrl(clientUrl) })
}

/** Rotates the access key and prints the new link or key once. Answers the exit code. */
export async function rotateKeyCommand(options: RotateKeyOptions): Promise<number> {
  try {
    const throughHost = await rotateThroughHost(options.hostUrl)
    const result = throughHost ?? rotateFile(options)
    console.log(
      throughHost
        ? 'Access key rotated. Sessions that used the old key were closed.'
        : 'Access key rotated. The host was not serving remote access; it uses this key once remote access is on.',
    )
    console.log(
      result.link ? `Connect link: ${result.link}` : `Machine id: ${result.machineId}\nAccess key: ${result.key}`,
    )
    console.log('It will not be shown again.')
    return 0
  } catch (error) {
    console.error(`rotating the key failed: ${error instanceof Error ? error.message : error}`)
    return 1
  }
}
