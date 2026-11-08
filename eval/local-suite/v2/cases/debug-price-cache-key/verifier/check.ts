const dir = process.env.CANDIDATE_DIR!;
const { price } = await import(`${dir}/src/price.ts`);
const { stats } = await import(`${dir}/src/catalog.ts`);

const bad: string[] = [];
const near = (name: string, got: number, want: number) => {
  if (Math.abs(got - want) > 1e-9) bad.push(`${name}: got ${got}, want ${want}`);
};

stats.loads = 0;
near('A usd', price('A', 'USD'), 10);
near('A eur', price('A', 'EUR'), 9);
near('A usd again', price('A', 'USD'), 10);
near('A gbp', price('A', 'GBP'), 8);
near('A eur again', price('A', 'EUR'), 9);
near('B gbp first', price('B', 'GBP'), 20);
near('B usd after', price('B', 'USD'), 25);
near('C eur', price('C', 'EUR'), 3.6);
if (stats.loads > 6) bad.push(`memoization lost: ${stats.loads} catalog loads for 3 skus`);

const before = stats.loads;
for (let i = 0; i < 20; i++) price('A', 'EUR');
if (stats.loads - before > 0) bad.push('repeat of an already-priced pair reloaded the catalog');

let threw = false;
try {
  price('A', 'XXX');
} catch {
  threw = true;
}
if (!threw) bad.push('unknown currency no longer throws');

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
