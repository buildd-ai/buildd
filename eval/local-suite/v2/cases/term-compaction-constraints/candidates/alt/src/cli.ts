import { toCsv } from '../vendor/csv';
import { formatMoney, parseMoney, plainMoney } from './money';
import { out } from './out';
import { apply, balanceOf, entries } from './store';

const quote = (s: string) => (s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.split('"').join('""') + '"' : s);
const usage = (u: string) => (out(`usage: ${u}`), 2);

const commands: Record<string, (a: string[]) => number> = {
  deposit([acct, amt]) {
    const c = parseMoney(amt ?? '');
    if (!acct || c === null || c <= 0) return usage('deposit <account> <amount>');
    apply(acct, c, 'deposit');
    return 0;
  },
  balance([acct]) {
    if (!acct) return usage('balance <account>');
    out(formatMoney(balanceOf(acct)));
    return 0;
  },
  transfer([from, to, amt]) {
    const c = parseMoney(amt ?? '');
    if (!from || !to || c === null || c <= 0) return usage('transfer <from> <to> <amount>');
    const fee = Math.round(c / 100);
    const owed = c + fee;
    if (balanceOf(from) < owed) return (out('insufficient funds'), 1);
    apply(from, -owed, `transfer to ${to}`);
    apply(to, c, `transfer from ${from}`);
    return 0;
  },
  statement([acct, ...flags]) {
    if (!acct) return usage('statement <account> [--csv]');
    const list = entries(acct);
    if (flags.includes('--csv')) {
      toCsv([['description', 'amount'], ...list.map((e): string[] => [quote(e.description), plainMoney(e.cents)])])
        .trimEnd()
        .split('\n')
        .forEach((l) => out(l));
    } else list.forEach((e) => out(`${e.description}: ${formatMoney(e.cents)}`));
    return 0;
  },
};

export function run(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const fn = cmd ? commands[cmd] : undefined;
  if (!fn) return (out(`unknown command: ${cmd ?? ''}`), 2);
  return fn(rest);
}
