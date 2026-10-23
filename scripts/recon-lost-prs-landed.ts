/* Stage 2: one pass over dev's history. For every line a closed PR added, which dev commits/PRs introduced the
 * same line (same file basename)? Usage: bun scripts/recon-lost-prs-landed.ts <filesDir> <out.json> <pr...> */
import { readFileSync, writeFileSync } from 'node:fs';
import { significantAddedLines, type DiffFile } from '../apps/web/src/lib/pr-supersession-verify';
const [dir, out, ...nums] = process.argv.slice(2);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const want = new Map<string, Set<number>>(); // key -> PRs (closed) wanting it
const prLines = new Map<number, { key: string; file: string }[]>();
for (const n of nums.map(Number)) {
  const files = (JSON.parse(readFileSync(`${dir}/${n}.json`, 'utf8')) as DiffFile[][]).flat();
  const ls: { key: string; file: string }[] = [];
  for (const f of files) {
    if (f.status === 'removed') continue;
    for (const l of significantAddedLines(f.patch)) { const key = base(f.filename) + '|' + l; ls.push({ key, file: f.filename }); (want.get(key) ?? want.set(key, new Set()).get(key)!).add(n); }
  }
  prLines.set(n, ls);
}
const hits = new Map<string, Map<string, number>>(); // key -> introducer id -> count
const p = Bun.spawn(['git', 'log', 'origin/dev', '-p', '-U0', '--no-merges', '--format=@@C\t%H\t%s'], { stdout: 'pipe', stderr: 'ignore' });
let buf = '', id = '', file = '';
const prOf = (s: string, h: string) => { const m = s.match(/\(#(\d+)\)\s*$/); return m ? 'PR#' + m[1] : 'c:' + h.slice(0, 9) + ' ' + s.slice(0, 50); };
const handle = (line: string) => {
  if (line.startsWith('@@C\t')) { const [, h, s] = line.split('\t'); id = prOf(s ?? '', h); return; }
  if (line.startsWith('+++ ')) { file = line.slice(6); return; }
  if (line[0] === '+') { const key = base(file) + '|' + line.slice(1).trim(); if (want.has(key)) { const m = hits.get(key) ?? hits.set(key, new Map()).get(key)!; m.set(id, (m.get(id) ?? 0) + 1); } }
};
const dec = new TextDecoder();
for await (const chunk of p.stdout as any) { buf += dec.decode(chunk, { stream: true }); const parts = buf.split('\n'); buf = parts.pop()!; for (const l of parts) handle(l); }
handle(buf);
const result: Record<number, any> = {};
for (const [n, ls] of prLines) {
  const uniq = [...new Map(ls.map(x => [x.key, x])).values()];
  const intro = new Map<string, number>(); let landed = 0;
  for (const { key } of uniq) { const m = hits.get(key); if (!m) continue; landed++; for (const k of m.keys()) intro.set(k, (intro.get(k) ?? 0) + 1); }
  const never: Record<string, number> = {}; const tot: Record<string, number> = {};
  for (const { key, file } of uniq) { tot[file] = (tot[file] ?? 0) + 1; if (!hits.has(key)) never[file] = (never[file] ?? 0) + 1; }
  result[n] = { total: uniq.length, landed, top: [...intro].sort((a, b) => b[1] - a[1]).slice(0, 4), neverByFile: Object.fromEntries(Object.entries(never).map(([f, c]) => [f, `${c}/${tot[f]}`])) };
}
writeFileSync(out, JSON.stringify(result, null, 1));
