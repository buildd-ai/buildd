#!/usr/bin/env bun
/**
 * Build the publishable package into `dist/`.
 *
 * In the workspace, `package.json` exports point at `src/*.ts` (like every
 * other buildd package), so buildd consumes the source with no build step.
 * The published package is `dist/`: compiled ESM + `.d.ts`, the theme, the
 * README/CHANGELOG/LICENSE, and a generated `package.json` whose exports
 * point at the compiled files. Publish with `npm publish` from `dist/`.
 */
import { $ } from 'bun';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');

type Pkg = Record<string, unknown> & { exports: Record<string, string> };

/** `./src/chat/contract/index.ts` → `{ types, import }` under dist; non-TS files copy as-is. */
export function distExports(exportsMap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(exportsMap)) {
    if (key === './package.json') { out[key] = './package.json'; continue; }
    const rel = target.replace(/^\.\/src\//, './');
    if (rel.endsWith('.ts')) {
      const base = rel.slice(0, -'.ts'.length);
      out[key] = { types: `${base}.d.ts`, import: `${base}.js` };
    } else {
      out[key] = rel;
    }
  }
  return out;
}

export function distPackageJson(pkg: Pkg): Record<string, unknown> {
  const { scripts: _s, devDependencies: _d, exports, ...rest } = pkg;
  return { ...rest, exports: distExports(exports), publishConfig: { access: 'public', provenance: true } };
}

if (import.meta.main) {
  rmSync(dist, { recursive: true, force: true });
  await $`bunx tsc -p ${join(root, 'tsconfig.build.json')}`;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pkg;
  for (const [, target] of Object.entries(pkg.exports)) {
    if (!target.startsWith('./src/') || target.endsWith('.ts')) continue;
    cpSync(join(root, target), join(dist, target.replace(/^\.\/src\//, '')));
  }
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
  }
  writeFileSync(join(dist, 'package.json'), `${JSON.stringify(distPackageJson(pkg), null, 2)}\n`);
  console.log(`built @buildd/ai-kit@${pkg.version} → ${dist}`);
}
