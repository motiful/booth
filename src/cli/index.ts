import { createInterface } from 'node:readline'
import { findProjectRoot } from '../constants.js'
import { isDaemonRunning } from '../ipc.js'
import { startCommand, ensureDaemonAndSession, launchDJ, attachSession } from './commands/start.js'
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
import { resumeCommand, readArchivesFromState } from './commands/resume.js'
import { restartCommand } from './commands/restart.js'
import { initCommand } from './commands/init.js'
import { isInitialized } from '../skills.js'

const HELP = `
booth — AI project manager for Claude Code

Usage:
  booth                Start booth (interactive: resume / start fresh / show status)
  booth init           First-time setup (register skills, can re-run for recovery)
  booth spin <name>    Create a new deck (parallel CC instance)
  booth ls             List all deck states
  booth status <name>  Show details for a specific deck
  booth peek <name>    View a deck's tmux pane content
  booth send <name> --prompt "..."  Send a prompt to an idle/holding deck
  booth kill <name>    Kill a deck
  booth resume         Resume archived decks (auto-starts daemon if needed)
  booth resume <name>  Resume a specific archived deck
  booth resume --list  List all archived decks
  booth stop           Stop booth (daemon + all decks)
  booth restart        Restart booth (stop + start + resume all)
  booth restart --clean  Restart booth clean (stop + start, no deck recovery)
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

async function bareBoothCommand(): Promise<void> {
  // Auto-init on first run
  if (!isInitialized()) {
    await initCommand([])
    console.log()
  }

  const projectRoot = findProjectRoot()
  const running = await isDaemonRunning(projectRoot)

  if (running) {
    // Daemon running → show status then attach
    await lsCommand([])
    await startCommand([])
    return
  }

  // Daemon not running — check for archived decks
  const archives = readArchivesFromState(projectRoot)
  if (archives.length === 0) {
    // No archives → start fresh
    await startCommand([])
    return
  }

  // Has archives → prompt user
  console.log(`[booth] Found ${archives.length} archived deck(s):`)
  for (const a of archives) {
    console.log(`  - ${a.name} [${a.mode}]`)
  }
  console.log()

  const choice = await askChoice(
    'Start fresh or resume previous decks? [r]esume / [f]resh (default: resume): ',
    ['r', 'f', 'resume', 'fresh', '']
  )

  // Setup daemon + DJ first (non-blocking)
  await ensureDaemonAndSession(projectRoot)
  await launchDJ(projectRoot)

  if (choice !== 'f' && choice !== 'fresh') {
    console.log('[booth] resuming archived decks...')
    await resumeCommand([])
  }

  // Attach last (blocks until user detaches)
  attachSession(projectRoot)
}

function askChoice(prompt: string, valid: string[]): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      if (valid.includes(trimmed)) {
        resolve(trimmed)
      } else {
        resolve('') // default
      }
    })
  })
}

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
        await bareBoothCommand()
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
      case 'restart':
        await restartCommand(rest)
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
