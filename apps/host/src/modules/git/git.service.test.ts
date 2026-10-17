import { describe, expect, test } from 'bun:test'
import { getGitStatus } from './git.service'

describe('getGitStatus', () => {
  test('returns an empty result for a folder that is not a repository', async () => {
    expect(await getGitStatus('/')).toEqual({ branch: null, changes: 0 })
  })
})
