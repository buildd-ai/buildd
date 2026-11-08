const dir = process.env.CANDIDATE_DIR!;
const { invoiceLine } = await import(`${dir}/src/invoice.ts`);
const { receiptLine } = await import(`${dir}/src/receipt.ts`);
const { reportRow } = await import(`${dir}/src/report.ts`);
const { summary } = await import(`${dir}/src/summary.ts`);

const bad: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (got !== want) bad.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// USD behaviour, quirks included.
eq('inv pos', invoiceLine('A', 12.5), 'A: $12.50');
eq('inv neg half', invoiceLine('A', -0.125), 'A: -$0.12');
eq('inv tiny neg', invoiceLine('A', -0.001), 'A: $0.00');
eq('rec pos', receiptLine('a', 12.5), 'A USD 12.50');
eq('rec neg half', receiptLine('a', -0.125), 'A USD -0.13');
eq('rec tiny neg', receiptLine('a', -0.001), 'A USD -0.00');
eq('rep grouping', reportRow('Rent', 1234567.891), 'Rent'.padEnd(12) + '$1,234,567.89'.padStart(14));
eq('rep neg', reportRow('Rent', -42), 'Rent'.padEnd(12) + '($42.00)'.padStart(14));
eq('rep tiny neg', reportRow('R', -0.001), 'R'.padEnd(12) + '($0.00)'.padStart(14));
eq('explicit usd same', invoiceLine('A', -0.125, 'USD'), invoiceLine('A', -0.125));

// EUR: only the marker moves.
eq('inv eur', invoiceLine('A', 12.5, 'EUR'), 'A: €12.50');
eq('inv eur neg half', invoiceLine('A', -0.125, 'EUR'), 'A: -€0.12');
eq('rec eur', receiptLine('a', 12.5, 'EUR'), 'A EUR 12.50');
eq('rec eur neg half', receiptLine('a', -0.125, 'EUR'), 'A EUR -0.13');
eq('rep eur', reportRow('Rent', 1234567.891, 'EUR'), 'Rent'.padEnd(12) + '€1,234,567.89'.padStart(14));
eq('rep eur neg', reportRow('Rent', -42, 'EUR'), 'Rent'.padEnd(12) + '(€42.00)'.padStart(14));

// summary forwards.
const items = [{ label: 'Plan', amount: -0.125 }, { label: 'Fee', amount: 1000 }];
const usd = summary(items);
eq('summary default', usd[0], [invoiceLine('Plan', -0.125), receiptLine('Plan', -0.125), reportRow('Plan', -0.125)].join(' | '));
const eur = summary(items, 'EUR');
eq('summary eur', eur[1], [invoiceLine('Fee', 1000, 'EUR'), receiptLine('Fee', 1000, 'EUR'), reportRow('Fee', 1000, 'EUR')].join(' | '));
eq('summary eur has no dollar', /\$|USD/.test(eur.join('\n')), false);

// Unknown currency.
for (const [n, f] of [['inv', () => invoiceLine('A', 1, 'GBP' as any)], ['rec', () => receiptLine('A', 1, 'GBP' as any)], ['rep', () => reportRow('A', 1, 'GBP' as any)], ['sum', () => summary(items, 'GBP' as any)]] as const) {
  try {
    f();
    bad.push(`${n}: unknown currency did not throw`);
  } catch (e) {
    if (!(e instanceof RangeError)) bad.push(`${n}: threw ${(e as Error).name}, want RangeError`);
  }
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
