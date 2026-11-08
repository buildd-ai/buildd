import { parseMoney } from './money';
import { out } from './out';
import { apply } from './store';

/** Runs one command and returns the process exit code. Everything printed goes through out(). */
export function run(argv: string[]): number {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'deposit': {
      const cents = parseMoney(args[1] ?? '');
      if (!args[0] || cents === null || cents <= 0) {
        out('usage: deposit <account> <amount>');
        return 2;
      }
      apply(args[0], cents, 'deposit');
      return 0;
    }
    default:
      out(`unknown command: ${cmd ?? ''}`);
      return 2;
  }
}
