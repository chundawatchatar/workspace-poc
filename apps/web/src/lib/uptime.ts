const units = [
  { label: 'd', ms: 86_400_000 },
  { label: 'h', ms: 3_600_000 },
  { label: 'm', ms: 60_000 },
  { label: 's', ms: 1000 },
]

/** A duration in its two largest units, such as `2h 13m` or `45s`. Seconds are dropped from a minute up. */
export function formatUptime(ms: number): string {
  let rest = Math.max(0, Math.floor(ms / 1000) * 1000)
  const parts: string[] = []
  for (const unit of units) {
    if (unit.label === 's' && parts.length > 0) break
    const count = Math.floor(rest / unit.ms)
    rest -= count * unit.ms
    if (count > 0 || parts.length > 0) parts.push(`${count}${unit.label}`)
    if (parts.length === 2) break
  }
  return parts.length > 0 ? parts.join(' ') : '0s'
}
