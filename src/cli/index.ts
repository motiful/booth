import { startCommand } from './commands/start.js'
import { spinCommand } from './commands/spin.js'
import { lsCommand } from './commands/ls.js'

const HELP = `
booth — AI project manager for Claude Code

Usage:
  booth start          Start DJ + daemon in tmux
  booth spin <name>    Create a new deck (parallel CC instance)
  booth ls             List all deck states
  booth kill <name>    Kill a deck
  booth stop           Stop booth (daemon + all decks)
  booth --help         Show this help

Options:
  --help, -h           Show help
  --version, -v        Show version
`.trim()

export async function run(args: string[]): Promise<void> {
  const cmd = args[0]
  const rest = args.slice(1)

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    process.exit(0)
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log('booth 0.1.0')
    process.exit(0)
  }

  try {
    switch (cmd) {
      case 'start':
        await startCommand(rest)
        break
      case 'spin':
        await spinCommand(rest)
        break
      case 'ls':
        await lsCommand(rest)
        break
      case 'kill':
      case 'stop':
        console.log(`[booth] "${cmd}" not yet implemented`)
        process.exit(1)
        break
      default:
        console.error(`Unknown command: ${cmd}`)
        console.log(HELP)
        process.exit(1)
    }
  } catch (err) {
    console.error(`[booth] error: ${(err as Error).message}`)
    process.exit(1)
  }
}
