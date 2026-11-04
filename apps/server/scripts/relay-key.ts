import { generateRelaySigningKey } from '../src/modules/machines/relay-ticket.service'

// Prints a new relay signing key for `RELAY_SIGNING_KEY` in the root `.env`, and its public key, which can go in
// `RELAY_EXTRA_PUBLIC_KEYS` ahead of a rotation. Usage: `bun apps/server/scripts/relay-key.ts [kid]`.

const kid = process.argv[2] ?? new Date().toISOString().slice(0, 10)
if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) {
  console.error('the key id must be 1 to 32 letters, digits, `-` or `_`')
  process.exit(1)
}
const { value, publicKey } = generateRelaySigningKey(kid)
console.log(`RELAY_SIGNING_KEY=${value}`)
console.log(`# its public key, for RELAY_EXTRA_PUBLIC_KEYS before a rotation: ${kid}:${publicKey}`)
