/* Stage 3: symbol survival. For each PR, the identifiers it declared (function/const/class/type names, test titles
 * excluded) and the files it added: are they on origin/dev now? Needs <filesDir-sibling>/devids.txt = `git grep -h -o -E '[A-Za-z_$][A-Za-z0-9_$]{6,}' origin/dev | sort -u`. Usage: bun scripts/recon-lost-prs-symbols.ts <filesDir> <out.json> <pr...> */
import { readFileSync, writeFileSync } from 'node:fs';
const [dir, out, ...nums] = process.argv.slice(2);
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { maxBuffer: 256 * 1024 * 1024 }); return r.exitCode === 0 ? r.stdout.toString() : ''; };
const devIds = new Set(readFileSync(process.argv[2].replace(/files$/, 'devids.txt'), 'utf8').split('\n'));
const tree = new Set(sh(['git', 'ls-tree', '-r', '--name-only', 'origin/dev']).split('\n'));
const baseToPaths = new Map<string, number>();
for (const p of tree) { const b = p.slice(p.lastIndexOf('/') + 1); baseToPaths.set(b, (baseToPaths.get(b) ?? 0) + 1); }
const DECL = /\b(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]{6,})/;
const result: Record<number, any> = {};
for (const n of nums.map(Number)) {
  const files = (JSON.parse(readFileSync(`${dir}/${n}.json`, 'utf8')) as any[][]).flat();
  const added = files.filter(f => f.status === 'added' && !/\.(snap|json|lock|md|sql)$/.test(f.filename));
  const addedOnDev = added.filter(f => tree.has(f.filename)).length;
  const addedByBase = added.filter(f => !tree.has(f.filename) && baseToPaths.has(f.filename.slice(f.filename.lastIndexOf('/') + 1))).length;
  const ids = new Map<string, number>();
  for (const f of files) {
    if (f.status === 'removed' || /\.(test|spec)\.|__tests__|\.snap$|\.md$|\.json$|\.sql$|bun\.lock/.test(f.filename)) continue;
    for (const raw of (f.patch ?? '').split('\n')) {
      if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
      const m = raw.slice(1).match(DECL); if (m) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
    }
  }
  const all = [...ids.keys()].sort((a, b) => b.length - a.length).slice(0, 25);
  const present: string[] = [], absent: string[] = [];
  for (const id of all) (devIds.has(id) ? present : absent).push(id);
  result[n] = { addedFiles: added.length, addedOnDev, addedByBase, symbols: all.length, present: present.length, absent: absent.slice(0, 8) };
  writeFileSync(out, JSON.stringify(result, null, 1));
}
