/**
 * Re-pin a v2 suite after editing case files: recompute each case's
 * contentHash from the bytes its manifest names, write it back to case.json
 * and make suite.json list exactly the case directories present, pinned.
 * Editing a case changes its hash; bump `version` in case.json first when the
 * edit is meant to supersede an admitted case (admission evidence is per
 * version and hash).
 *
 *   bun scripts/local-eval/v2-seal.ts [--root eval/local-suite/v2]
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeContentHash, namedPaths, type SuiteV2 } from '../../packages/core/local-eval-v2';
import { DEFAULT_ROOT, loadSuiteV2 } from './v2';

export function sealSuite(root: string): { id: string; version: number; contentHash: string; changed: boolean }[] {
  const { suite, cases } = loadSuiteV2(root);
  const out: { id: string; version: number; contentHash: string; changed: boolean }[] = [];
  for (const dirName of Object.keys(cases).sort()) {
    const c = cases[dirName];
    const hash = computeContentHash(c.files, namedPaths(c.manifest));
    const changed = hash !== c.manifest.contentHash;
    if (changed) {
      c.manifest.contentHash = hash;
      c.manifest.admission = null; // admitted bytes changed: the old record no longer applies
      writeFileSync(join(c.dir, 'case.json'), JSON.stringify(c.manifest, null, 2) + '\n');
    }
    out.push({ id: c.manifest.id, version: c.manifest.version, contentHash: hash, changed });
  }
  const next: SuiteV2 = { ...suite, cases: out.map(({ id, version, contentHash }) => ({ id, version, contentHash })) };
  writeFileSync(join(root, 'suite.json'), JSON.stringify(next, null, 2) + '\n');
  return out;
}

if (import.meta.main) {
  const i = process.argv.indexOf('--root');
  const root = resolve(i > -1 ? process.argv[i + 1] : DEFAULT_ROOT);
  for (const r of sealSuite(root)) console.log(`${r.id} v${r.version} ${r.contentHash.slice(0, 12)}${r.changed ? ' (re-pinned)' : ''}`);
}
