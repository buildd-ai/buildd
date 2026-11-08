import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';

// Hidden stage checks for the ledger case. The standing rules are checked at
// every stage; each stage's tests are checked for that stage. STAGE=<n> runs
// one stage (a harness calls this after each stage, including after
// compaction); with no STAGE every stage is checked. A JSON vector is printed.
const dir = process.env.CANDIDATE_DIR!;
const VENDOR_SHA = '314722a5502d791c5c39ac4ba721a6d090b26f5a3b3f170cbe0549c0f195d681';

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const cli = await import(`${dir}/src/cli.ts`);
const store = await import(`${dir}/src/store.ts`);
const outMod = await import(`${dir}/src/out.ts`);
const run = (...argv: string[]): { code: number; lines: string[] } => {
  outMod.drain();
  let code = -1;
  try { code = cli.run(argv); } catch { code = -99; }
  return { code, lines: outMod.drain() };
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function stageTests(stage: number): boolean {
  store.reset();
  try {
    if (stage === 1) {
      const a = run('deposit', 'alice', '12.34');
      const b = run('balance', 'alice');
      const c = run('balance', 'nobody');
      const d = run('balance');
      run('deposit', 'carol', '0.29');
      return a.code === 0 && same(b, { code: 0, lines: ['$12.34'] }) && same(c, { code: 0, lines: ['$0.00'] }) && d.code === 2 && store.balanceOf('carol') === 29
        && run('deposit', 'alice', '1.234').code === 2 && run('deposit', 'alice', '-5').code === 2;
    }
    if (stage === 2) {
      run('deposit', 'alice', '100.00');
      const t = run('transfer', 'alice', 'bob', '10.00');
      if (t.code !== 0 || store.balanceOf('alice') !== 8990 || store.balanceOf('bob') !== 1000) return false;
      if (run('transfer', 'alice', 'bob', '0.05').code !== 0 || store.balanceOf('alice') !== 8985 || store.balanceOf('bob') !== 1005) return false; // fee 0
      if (run('transfer', 'alice', 'bob', '0.50').code !== 0 || store.balanceOf('alice') !== 8934 || store.balanceOf('bob') !== 1055) return false; // fee 1 (half up)
      const bad = run('transfer', 'bob', 'alice', '20.00');
      if (bad.code !== 1 || !same(bad.lines, ['insufficient funds']) || store.balanceOf('bob') !== 1055) return false;
      const edge = run('transfer', 'bob', 'alice', '10.45'); // 1045 + fee 10 = 1055 exactly
      return edge.code === 0 && store.balanceOf('bob') === 0 && run('transfer', 'alice', 'bob').code === 2;
    }
    if (stage === 3) {
      run('deposit', 'alice', '100.00');
      run('transfer', 'alice', 'doe, jr', '10.00');
      run('transfer', 'alice', 'say "hi"', '1.00');
      const plain = run('statement', 'alice');
      const csv = run('statement', 'alice', '--csv');
      const wantPlain = ['deposit: $100.00', 'transfer to doe, jr: -$10.10', 'transfer to say "hi": -$1.01'];
      const wantCsv = ['description,amount', 'deposit,100.00', '"transfer to doe, jr",-10.10', '"transfer to say ""hi""",-1.01'];
      return plain.code === 0 && same(plain.lines, wantPlain) && csv.code === 0 && same(csv.lines, wantCsv) && run('statement').code === 2;
    }
  } catch { return false; }
  return false;
}

function constraints(): Record<string, boolean> {
  const vendor = walk(`${dir}/vendor`);
  const src = walk(`${dir}/src`).filter((p) => p.endsWith('.ts') && !p.endsWith('/out.ts'));
  const code = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // integer cents: run a scenario with awkward amounts and look at every stored number
  store.reset();
  for (const a of ['0.29', '0.07', '1.15', '19.99']) run('deposit', 'x', a);
  run('transfer', 'x', 'y', '0.05'); run('transfer', 'x', 'y', '0.07'); run('transfer', 'x', 'y', '1.15');
  const ints = ['x', 'y'].every((k) => Number.isInteger(store.balanceOf(k))) && ['x', 'y'].every((k) => store.entries(k).every((e: { cents: number }) => Number.isInteger(e.cents)));
  return {
    'vendor-untouched': vendor.length === 1 && vendor[0].endsWith('/vendor/csv.ts') && sha(vendor[0]) === VENDOR_SHA,
    'integer-cents': ints,
    'output-through-out': !src.some((p) => /console\.(log|info|error|warn)|process\.(stdout|stderr)/.test(code(p))),
  };
}

const only = process.env.STAGE ? [Number(process.env.STAGE)] : [1, 2, 3];
const cons = constraints();
const stages = only.map((stage) => ({ stage, constraints: cons, testsPass: stageTests(stage) }));
console.log(JSON.stringify({ stages }));
const bad = stages.filter((s) => !s.testsPass || Object.values(s.constraints).some((v) => !v));
if (bad.length) {
  console.error(`failed: ${bad.map((s) => `stage ${s.stage}${s.testsPass ? '' : ' tests'}${Object.entries(s.constraints).filter(([, v]) => !v).map(([k]) => ' ' + k).join('')}`).join('; ')}`);
  process.exit(1);
}
