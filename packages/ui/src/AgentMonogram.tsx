/** Draws an agent's fallback initials inside its icon's SVG. */
export function AgentMonogram({ label }: { label: string }) {
  return (
    <>
      <rect x="0.6" y="0.6" width="14.8" height="14.8" rx="3.5" stroke="currentColor" strokeWidth="1.2" />
      <text
        x="8"
        y="8.6"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={label.length > 1 ? 8.5 : 11}
        fontWeight="800"
        letterSpacing="-0.5"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {label}
      </text>
    </>
  )
}
