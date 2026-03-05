import { startCommand } from './commands/start.js'
import { spinCommand } from './commands/spin.js'
import { lsCommand } from './commands/ls.js'
import { killCommand } from './commands/kill.js'
import { stopCommand } from './commands/stop.js'
import { configCommand } from './commands/config.js'
import { reloadCommand } from './commands/reload.js'
import { liveCommand } from './commands/live.js'
import { autoCommand } from './commands/auto.js'
import { holdCommand } from './commands/hold.js'
import { statusCommand } from './commands/status.js'
import { peekCommand } from './commands/peek.js'
import { sendCommand } from './commands/send.js'
import { reportsCommand } from './commands/reports.js'
import { resumeCommand } from './commands/resume.js'
import { initCommand } from './commands/init.js'
import { isInitialized } from '../skills.js'

const HELP = `
booth — AI project manager for Claude Code

Usage:
  booth                Start booth (auto-init on first run)
  booth init           First-time setup (register skills, can re-run for recovery)
  booth spin <name>    Create a new deck (parallel CC instance)
  booth ls             List all deck states
  booth status <name>  Show details for a specific deck
  booth peek <name>    View a deck's tmux pane content
  booth send <name> --prompt "..."  Send a prompt to an idle/holding deck
  booth kill <name>    Kill a deck
  booth resume         Resume archived decks
  booth resume <name>  Resume a specific archived deck
  booth resume --list  List all archived decks
  booth stop           Stop booth (daemon + all decks)
  booth live <name>    Switch deck to live mode (no auto-check)
  booth auto <name>    Switch deck to auto mode (default)
  booth hold <name>    Switch deck to hold mode (check but don't kill)
  booth reload         Hot-restart daemon (preserves tmux sessions)
  booth reports        List all reports
  booth reports <name> Print a report to stdout
  booth reports open <name>  Open a report in editor
  booth config <cmd>   Manage config (set/get/list)
  booth --help         Show this help

Options:
  --help, -h           Show help
  --version, -v        Show version
`.trim()

export async function run(args: string[]): Promise<void> {
  const cmd = args[0]
  const rest = args.slice(1)

  if (cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    process.exit(0)
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log('booth 0.1.0')
    process.exit(0)
  }

  try {
    switch (cmd) {
      case undefined:
        // Bare `booth` — interactive entry point
        // Auto-init on first run; skip silently if already done
        if (!isInitialized()) {
          await initCommand([])
          console.log()
        }
        await startCommand(rest)
        break
      case 'start':
        await startCommand(rest)
        break
      case 'init':
        await initCommand(rest)
        break
      case 'spin':
        await spinCommand(rest)
        break
      case 'ls':
        await lsCommand(rest)
        break
      case 'status':
        await statusCommand(rest)
        break
      case 'peek':
        await peekCommand(rest)
        break
      case 'send':
        await sendCommand(rest)
        break
      case 'kill':
        await killCommand(rest)
        break
      case 'resume':
        await resumeCommand(rest)
        break
      case 'stop':
        await stopCommand(rest)
        break
      case 'live':
        await liveCommand(rest)
        break
      case 'auto':
        await autoCommand(rest)
        break
      case 'hold':
        await holdCommand(rest)
        break
      case 'reload':
        await reloadCommand(rest)
        break
      case 'reports':
        await reportsCommand(rest)
        break
      case 'config':
        await configCommand(rest)
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
