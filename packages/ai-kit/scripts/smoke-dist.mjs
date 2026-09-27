#!/usr/bin/env node
/**
 * Import every JS entry point of the built `dist/` under plain Node ESM.
 *
 * Source uses extensionless relative imports (see scripts/build.ts); Node ESM
 * does not, so a dist whose specifiers were not rewritten fails here with
 * ERR_MODULE_NOT_FOUND instead of at a consumer's runtime. Run after
 * `bun run build`: `node scripts/smoke-dist.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const pkg = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
let n = 0;
for (const [entry, target] of Object.entries(pkg.exports)) {
  if (typeof target !== 'object' || !target.import) continue;
  const mod = await import(pathToFileURL(join(dist, target.import)).href);
  console.log(`ok ${pkg.name}${entry.slice(1)} (${Object.keys(mod).length} runtime exports)`);
  n++;
}
if (n === 0) throw new Error('no JS entry points found in dist/package.json');
