/* Recon: PRs closed unmerged by buildd. Usage: bun scripts/recon-lost-prs.ts <out.jsonl> <pr...>
 * Appends one JSON line per PR; skips PRs already in the file. Foreground, sequential. */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { parseSupersessionClaims, significantAddedLines, verifyByContent, mapPath, type DiffFile } from '../apps/web/src/lib/pr-supersession-verify';

const REPO = 'buildd-ai/buildd';
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { maxBuffer: 256 * 1024 * 1024 }); return r.exitCode === 0 ? r.stdout.toString() : null; };
const gh = (path: string) => { const o = sh(['gh', 'api', '--paginate', '--slurp', path]); return o ? (JSON.parse(o) as any[]).flat() : null; };
const trim = (l: string) => l.trim();
const sig = (l: string) => l.length >= 4 && /[A-Za-z0-9]/.test(l);

const devTree = (sh(['git', 'ls-tree', '-r', '--name-only', 'origin/dev']) ?? '').split('\n').filter(Boolean);
const byBase = new Map<string, string[]>();
for (const p of devTree) { const b = p.slice(p.lastIndexOf('/') + 1); (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(p); }

function devPathFor(p: string): string | null {
  if (devTree.includes(p)) return p;
  const b = p.slice(p.lastIndexOf('/') + 1);
  const c = (byBase.get(b) ?? []).map(x => ({ x, s: x.split('/').reverse().reduce((n, seg, i, a) => n, 0) }));
  let best: string | null = null, bs = 0;
  for (const { x } of c) { const a = x.split('/').reverse(), q = p.split('/').reverse(); let n = 0; while (n < a.length && n < q.length && a[n] === q[n]) n++; if (n > bs) { bs = n; best = x; } }
  return bs >= 2 ? best : null;
}

const [out, ...nums] = process.argv.slice(2);
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).number) : []);
for (const n of nums.map(Number)) {
  if (done.has(n)) continue;
  const rec: any = { number: n };
  try {
    const files = gh(`repos/${REPO}/pulls/${n}/files`) as DiffFile[] | null;
    const pr = JSON.parse(sh(['gh', 'api', `repos/${REPO}/pulls/${n}`]) ?? 'null');
    if (!files || !pr) { rec.error = 'unreadable'; appendFileSync(out, JSON.stringify(rec) + '\n'); continue; }
    rec.title = pr.title; rec.head = pr.head.ref; rec.base = pr.base.ref; rec.closedAt = pr.closed_at;
    const comments = (gh(`repos/${REPO}/issues/${n}/comments`) ?? []).map((c: any) => c.body).join('\n');
    const claims = parseSupersessionClaims(comments, REPO);
    rec.claims = claims.map(c => `${c.repo}#${c.prNumber}`);
    const w = claims.find(c => c.repo === REPO);
    if (w) {
      const wp = JSON.parse(sh(['gh', 'api', `repos/${REPO}/pulls/${w.prNumber}`]) ?? 'null');
      rec.winner = w.prNumber; rec.winnerMerged = !!wp?.merged_at; rec.winnerState = wp?.state;
      const wf = wp ? (gh(`repos/${REPO}/pulls/${w.prNumber}/files`) as DiffFile[] | null) : null;
      if (wf) { const v = verifyByContent(files, wf); rec.winnerContent = { verified: v.verified, ratio: +v.ratio.toFixed(2), lines: v.totalLines, files: v.files, blobs: v.blobMatches }; }
    }
    // cheap pass: PR's added lines vs the same file on dev
    let tot = 0, hit = 0; const fl: any[] = [];
    for (const f of files) {
      if (f.status === 'removed') continue;
      const lines = significantAddedLines(f.patch);
      if (!lines.length) { fl.push({ f: f.filename, n: 0, patch: !!f.patch }); continue; }
      const dp = devPathFor(f.filename);
      if (!dp) { tot += lines.length; fl.push({ f: f.filename, n: lines.length, hit: 0, gone: true }); continue; }
      const set = new Set((sh(['git', 'show', `origin/dev:${dp}`]) ?? '').split('\n').map(trim).filter(sig));
      const h = lines.filter(l => set.has(l)).length;
      tot += lines.length; hit += h;
      fl.push({ f: f.filename, dp: dp === f.filename ? undefined : dp, n: lines.length, hit: h });
    }
    rec.dev = { total: tot, hit, ratio: tot ? +(hit / tot).toFixed(2) : null, files: fl, nfiles: files.length };
  } catch (e) { rec.error = String(e); }
  appendFileSync(out, JSON.stringify(rec) + '\n');
}
