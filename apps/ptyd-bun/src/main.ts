import { runDaemon } from './daemon'

// Starts the terminal daemon from source. The host executable runs the same code through its daemon subcommand.
await runDaemon(process.argv)
