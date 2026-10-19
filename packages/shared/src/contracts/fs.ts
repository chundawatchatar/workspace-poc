import { z } from 'zod'
import { defineContract } from './contract'

export const resolveDirQuery = z.object({ path: z.string() })

/** `path` is null when the folder does not exist or the path is relative. */
export const resolveDirResponse = z.object({ path: z.string().nullable() })

export const listDirsQuery = z.object({ path: z.string() })

/** `path` is null when the folder does not exist or the path is relative. `parent` is null at the root. */
export const listDirsResponse = z.object({
  path: z.string().nullable(),
  parent: z.string().nullable(),
  dirs: z.array(z.string()),
})

export type DirListing = z.infer<typeof listDirsResponse>

export const makeDirBody = z.object({ parent: z.string(), name: z.string() })

/** Either `path` (the new folder) or `error` (why it could not be created) is set. */
export const makeDirResponse = z.object({ path: z.string().nullable(), error: z.string().nullable() })

export const fsContract = defineContract({
  resolveDir: {
    method: 'GET',
    path: '/api/fs/resolve-dir',
    description: 'Expands `~` and checks that the path is an existing directory, for the new workspace dialog.',
    input: resolveDirQuery,
    output: resolveDirResponse,
  },
  listDirs: {
    method: 'GET',
    path: '/api/fs/list-dirs',
    description:
      'The subfolders of a directory, hidden ones excluded, for the folder browser in the new workspace dialog.',
    input: listDirsQuery,
    output: listDirsResponse,
  },
  makeDir: {
    method: 'POST',
    path: '/api/fs/make-dir',
    description: 'Creates a folder inside `parent`, from the folder browser in the new workspace dialog.',
    input: makeDirBody,
    output: makeDirResponse,
  },
})
