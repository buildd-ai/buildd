#!/usr/bin/env bun
/**
 * Base drift: for each merged PR, how many OTHER PRs landed on the same base
 * while it was open. Bucketed, it predicts eventual-merge probability better
 * than any stored field.
 *
 * Usage: bun base-drift.ts <prs.json> [baseRef=dev]
 *   gh pr list --state all --limit 300 --json \
 *     number,title,state,createdAt,mergedAt,baseRefName,changedFiles > prs.json
 *   (adding author/commits/reviews at limit 300 blows the GraphQL node budget)
 */
import { readFileSync } from 'fs';

type PR = { number: number; title: string; state: string; createdAt: string;
            mergedAt: string | null; baseRefName: string; changedFiles: number };

const prs: PR[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const base = process.argv[3] ?? 'dev';
const t = (s: string | null) => (s ? Date.parse(s) : NaN);

const onBase = prs.filter(p => p.baseRefName === base);
const merges = onBase.filter(p => p.mergedAt).map(p => t(p.mergedAt)).sort((a, b) => a - b);
const pct = (a: number[], q: number) => a[Math.floor(q * (a.length - 1))];

const lifetimes = onBase.filter(p => p.mergedAt)
  .map(p => (t(p.mergedAt) - t(p.createdAt)) / 60000).sort((a, b) => a - b);
console.log(`${base}: ${merges.length} merged over ` +
  `${((merges.at(-1)! - merges[0]) / 86400000).toFixed(1)}d = ` +
  `${(merges.length / ((merges.at(-1)! - merges[0]) / 86400000)).toFixed(1)} PRs/day`);
console.log(`lifetime min: p50=${pct(lifetimes, .5).toFixed(0)} ` +
  `p90=${pct(lifetimes, .9).toFixed(0)} max=${lifetimes.at(-1)!.toFixed(0)}`);

const buckets = new Map<string, { n: number; merged: number }>();
const rows: Array<[number, number, string]> = [];
for (const p of onBase) {
  const a = t(p.createdAt), b = p.mergedAt ? t(p.mergedAt) : Date.now();
  const d = merges.filter(m => m > a && m < b).length;
  rows.push([d, p.number, p.title.slice(0, 55)]);
  const k = d === 0 ? '0' : d < 5 ? '1-4' : d < 15 ? '5-14' : '15+';
  const cur = buckets.get(k) ?? { n: 0, merged: 0 };
  cur.n++; if (p.state === 'MERGED') cur.merged++;
  buckets.set(k, cur);
}
console.log('\ndrift | PRs | eventually merged');
for (const k of ['0', '1-4', '5-14', '15+']) {
  const v = buckets.get(k); if (!v) continue;
  console.log(`${k.padStart(5)} | ${String(v.n).padStart(4)} | ${v.merged} (${Math.round(100 * v.merged / v.n)}%)`);
}
console.log('\nmost-drifted:');
for (const [d, n, ti] of rows.sort((x, y) => y[0] - x[0]).slice(0, 8)) console.log(`  ${String(d).padStart(3)}  #${n} ${ti}`);
