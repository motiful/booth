import { help } from './commands/help.js';
import { start } from './commands/start.js';
import { attach } from './commands/attach.js';
import { ls } from './commands/ls.js';
import { kill } from './commands/kill.js';
import { setup } from './commands/setup.js';
import { watch } from './commands/watch.js';
import { info } from './commands/info.js';
import { ps } from './commands/ps.js';

export function cli(argv: string[]): void {
  const cmd = argv[0] ?? '';

  // booth -h / booth --help / booth help
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    help();
    return;
  }

  switch (cmd) {
    case 'a':
      attach(argv.slice(1));
      break;
    case 'ls':
      ls();
      break;
    case 'kill':
      kill(argv.slice(1));
      break;
    case 'setup':
      setup();
      break;
    case 'watch':
      watch(argv.slice(1));
      break;
    case 'info':
      info();
      break;
    case 'ps':
      ps();
      break;
    default:
      // booth [<path>] — no subcommand = start
      // cmd is either empty string (no args) or a path
      start(cmd ? [cmd, ...argv.slice(1)] : []);
      break;
  }
}
