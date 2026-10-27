import { describe, expect, test } from 'bun:test'
import { copyWorkingFolder, workingFolder } from './commands'
import { getToast } from './toast'

describe('workingFolder', () => {
  test("prefers the session's live folder and falls back to the workspace's", () => {
    const workspace = { cwd: '/repo' }
    expect(workingFolder({ cwd: '/repo/src' }, workspace)).toBe('/repo/src')
    expect(workingFolder({ cwd: null }, workspace)).toBe('/repo')
    expect(workingFolder({ cwd: '' }, workspace)).toBe('/repo')
    expect(workingFolder(undefined, workspace)).toBe('/repo')
  })
})

describe('copyWorkingFolder', () => {
  test('writes the full folder and confirms with a toast', async () => {
    const written: string[] = []
    await copyWorkingFolder('unknown-session', '/tmp/project', async (text) => {
      written.push(text)
    })
    expect(written).toEqual(['/tmp/project'])
    expect(getToast()).toMatchObject({ message: 'Copied /tmp/project', kind: 'info' })
  })

  test('shows an error toast instead of throwing when the clipboard fails or is missing', async () => {
    await copyWorkingFolder('unknown-session', '/tmp/project', () => Promise.reject(new Error('denied')))
    const rejected = getToast()
    expect(rejected).toMatchObject({ message: 'Could not copy folder', kind: 'error' })

    // Bun's `navigator` has no clipboard, like a browser on an insecure origin.
    await copyWorkingFolder('unknown-session', '/tmp/project')
    expect(getToast()).toMatchObject({ message: 'Could not copy folder', kind: 'error' })
    expect(getToast()?.id).not.toBe(rejected?.id)
  })
})
