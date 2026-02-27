export function help(): void {
  console.log(`Booth — Parallel Claude Code Session Manager

Usage:
  booth [<path>]       Start DJ and attach (default: current dir)
  booth a [<name>]     Attach to DJ, or a specific deck
  booth ls             List sessions and deck registry
  booth kill [<name>]  Kill a specific deck, or everything
  booth watch <name>   Peek at a deck (popup in tmux, read-only outside)
  booth info           Show current project's Booth status
  booth ps             List all running Booth instances
  booth setup          Install CC skill + crontab heartbeat

Orchestration (public API):
  booth status [<name>]                   Show deck states (working/idle/error/…)
  booth log <name> [--lines N]            Tail deck JSONL or capture-pane output
  booth spawn <name> [--dir <path>]       Create a new deck
         [--prompt <text>] [--worktree]
  booth send <name> <message>             Send a message to a deck

  booth -h             Show this help

Per-project: each directory with .booth/ has its own DJ + decks.
Running "booth" auto-creates .booth/ and starts the DJ.

Examples:
  booth                Start DJ in current dir, auto-attach
  booth ~/myproject    Start DJ in ~/myproject, auto-attach
  booth a              Re-attach to DJ
  booth a api-refactor Enter deck "api-refactor"
  booth watch research Peek at the "research" deck
  booth info           Show project socket, status, sessions
  booth ps             Show all Booth instances across projects
  booth ls             Show what's running
  booth kill           Kill DJ + all decks
  booth kill stale-one Kill just one deck
  booth status         Show all deck states
  booth status api     Show state of "api" deck
  booth log api -n 30  Last 30 lines from "api" deck
  booth spawn worker --dir ~/proj --prompt "fix tests"
  booth send worker "run the linter"`);
}
