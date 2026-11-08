import { existsSync, readFileSync } from 'node:fs';

const p = `${process.env.CANDIDATE_DIR}/answer.json`;
if (!existsSync(p)) process.exit(1);
let a: any;
try {
  a = JSON.parse(readFileSync(p, 'utf8'));
} catch {
  process.exit(1);
}
const norm = (f: unknown) => String(f).replace(/^\.\//, '');
const cites: any[] = Array.isArray(a.citations) ? a.citations : [];
const target = 'packages/core/error-signature.ts';
const hit = cites.find((c) => norm(c.file) === target);
if (a.abstain || !hit) process.exit(1);
if (hit.symbol !== undefined && hit.symbol !== 'normalizeErrorSignature') {
  process.exit(1);
}
const callers = ['gate-friction-signature', 'failure-friction-signature'];
if (cites.some((c) => callers.some((n) => String(c.file).includes(n)))) {
  console.error('cited code that only calls or hashes the normalizer');
  process.exit(1);
}
console.log('ok');
