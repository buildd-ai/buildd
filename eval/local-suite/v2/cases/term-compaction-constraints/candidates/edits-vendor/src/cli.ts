import { toCsv } from '../vendor/csv';
import { formatMoney, parseMoney, plainMoney } from './money';
import { out } from './out';
import { apply, balanceOf, entries } from './store';

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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
    case 'balance': {
      if (!args[0]) {
        out('usage: balance <account>');
        return 2;
      }
      out(formatMoney(balanceOf(args[0])));
      return 0;
    }
    case 'transfer': {
      const [from, to] = args;
      const cents = parseMoney(args[2] ?? '');
      if (!from || !to || cents === null || cents <= 0) {
        out('usage: transfer <from> <to> <amount>');
        return 2;
      }
      const fee = Math.floor((cents + 50) / 100);
      if (balanceOf(from) < cents + fee) {
        out('insufficient funds');
        return 1;
      }
      apply(from, -(cents + fee), `transfer to ${to}`);
      apply(to, cents, `transfer from ${from}`);
      return 0;
    }
    case 'statement': {
      if (!args[0]) {
        out('usage: statement <account> [--csv]');
        return 2;
      }
      const rows = entries(args[0]);
      if (args.includes('--csv')) {
        const table = [['description', 'amount'], ...rows.map((e) => [e.description, plainMoney(e.cents)])];
        for (const line of toCsv(table).trimEnd().split('\n')) out(line);
      } else {
        for (const e of rows) out(`${e.description}: ${formatMoney(e.cents)}`);
      }
      return 0;
    }
    default:
      out(`unknown command: ${cmd ?? ''}`);
      return 2;
  }
}
