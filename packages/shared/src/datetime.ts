export type DateInput = string | number | Date

const dateTimeFormat: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/**
 * A date and time in the browser's locale and time zone, such as "Nov 2, 2026, 3:04 PM".
 * An unparseable value gives an empty string rather than "Invalid Date".
 */
export function formatLocalDateTime(value: DateInput): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, dateTimeFormat)
}
