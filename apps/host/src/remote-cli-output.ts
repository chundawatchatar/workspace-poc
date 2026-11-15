// What every `host:remote` command prints through: values from the host or a
// file are made safe for a terminal first.

/** Prints a host's refusal and answers the exit code. Null stands for a host that went away mid-command. */
export function refused(answer: { status: number; message: string } | null, err: (line: string) => void): number {
  err(answer ? printable(answer.message) : 'The host stopped. Run the command again')
  return 1
}

export function messageOf(error: unknown): string {
  return printable(error instanceof Error ? error.message : String(error))
}

/**
 * `value` with every control character (C0, DEL and C1) replaced by `?`. Names
 * and messages come from the server or a file, and a terminal would run escape
 * sequences in them, which could rewrite the lines the user checks before linking.
 */
export function printable(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}

/** As `printable`, but keeping line breaks and tabs, for a text of many lines such as a log. */
export function printableLines(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?')
}
