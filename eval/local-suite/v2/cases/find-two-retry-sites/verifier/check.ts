import { existsSync, readFileSync } from 'node:fs';

const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const p = `${process.env.CANDIDATE_DIR}/answer.json`;
if (!existsSync(p)) fail('no answer.json');
let a: any;
try {
  a = JSON.parse(readFileSync(p, 'utf8'));
} catch {
  fail('answer.json is not JSON');
}
const norm = (f: unknown) => String(f).replace(/^\.\//, '');
const cited = new Set<string>(
  (Array.isArray(a.citations) ? a.citations : []).map((c: any) => norm(c.file)),
);
if (a.abstain) fail('abstained where the behaviour exists');
for (const f of ['src/http/transport.ts', 'src/net/retry.ts']) {
  if (!cited.has(f)) fail(`missing plausible site ${f}`);
}
if (cited.has('src/queue/redelivery.ts')) fail('cited a fixed-delay site');
if (norm(a.liveSite) !== 'src/http/transport.ts') fail('wrong live site');
console.log('ok');
