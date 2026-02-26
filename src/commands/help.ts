export function help(): void {
  console.log(`Booth — Parallel Claude Code Session Manager

Usage:
  booth [<path>]       Start DJ and attach (default: current dir)
  booth a [<name>]     Attach to DJ, or a specific deck
  booth ls             List sessions and deck registry
  booth kill [<name>]  Kill a specific deck, or everything
  booth setup          Install CC skill + crontab heartbeat
  booth -h             Show this help

Per-project: each directory with .booth/ has its own DJ + decks.
Running "booth" auto-creates .booth/ and starts the DJ.

Examples:
  booth                Start DJ in current dir, auto-attach
  booth ~/myproject    Start DJ in ~/myproject, auto-attach
  booth a              Re-attach to DJ
  booth a api-refactor Enter deck "api-refactor"
  booth ls             Show what's running
  booth kill           Kill DJ + all decks
  booth kill stale-one Kill just one deck`);
}
