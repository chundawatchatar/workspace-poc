/** Where Bun keeps a compiled executable's own files, so `Bun.main` starts with it only in an executable. */
const COMPILED_ROOT = '/$bunfs/'

/**
 * The command that runs this entry point again. Compiled, that is the executable itself; from source it is Bun with
 * the runtime flags it was given (`--no-env-file`, `--define`) and the entry file, so a host started from source
 * starts its daemon and its background `run` the same way it was started.
 */
export function selfCommand(
  current: { execPath: string; execArgv: string[]; main: string } = {
    execPath: process.execPath,
    execArgv: process.execArgv,
    main: Bun.main,
  },
): string[] {
  if (current.main.startsWith(COMPILED_ROOT)) return [current.execPath]
  return [current.execPath, ...current.execArgv, current.main]
}
