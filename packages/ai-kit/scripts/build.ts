#!/usr/bin/env bun
/**
 * Build the publishable package into `dist/`.
 *
 * In the workspace, `package.json` exports point at `src/*.ts` (like every
 * other buildd package), so buildd consumes the source with no build step.
 * The published package is `dist/`: compiled ESM + `.d.ts`, the theme, the
 * README/CHANGELOG/LICENSE, and a generated `package.json` whose exports
 * point at the compiled files. Publish with `npm publish` from `dist/`.
 *
 * Relative imports in `src/` are extensionless (`./types`, not `./types.js`).
 * That is what lets a bundler consume the source with no config: Next 16's
 * Turbopack does not map `./x.js` to `./x.ts`, and `.ts` extensions would make
 * every consumer's `tsc` need `allowImportingTsExtensions`. Node ESM needs
 * real paths, so after `tsc` (bundler resolution) emits, every relative
 * specifier in dist `.js` and `.d.ts` is rewritten to the file it resolves to
 * (`./types.js`, `../chat/contract/index.js`). An unresolvable one fails the
 * build.
 */
import { $ } from 'bun';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** `from '…'`, `import '…'`, `import('…')` with a relative specifier. */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;
const HAS_EXTENSION = /\.(?:[cm]?js|json|css)$/;

/**
 * Rewrite extensionless relative specifiers in emitted code to the `.js` file
 * they resolve to under `dir`: `./x` → `./x.js`, or `./x/index.js` for a
 * directory. Throws on one that resolves to nothing, so a broken import can't
 * ship as a dist that only fails at the consumer's runtime.
 */
export function rewriteRelativeSpecifiers(code: string, dir: string, exists: (path: string) => boolean): string {
  return code.replace(RELATIVE_SPECIFIER, (whole, lead: string, quote: string, spec: string) => {
    if (HAS_EXTENSION.test(spec)) return whole;
    let resolved: string;
    if (exists(join(dir, `${spec}.js`))) resolved = `${spec}.js`;
    else if (exists(join(dir, spec, 'index.js'))) resolved = `${spec}/index.js`;
    else throw new Error(`cannot resolve relative import '${spec}' from ${dir}`);
    return `${lead}${quote}${resolved}${quote}`;
  });
}

function rewriteDist(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) continue;
    const file = join(dir, entry);
    const code = readFileSync(file, 'utf8');
    const out = rewriteRelativeSpecifiers(code, dirname(file), p => existsSync(p) && statSync(p).isFile());
    if (out !== code) writeFileSync(file, out);
  }
}

export function distPackageJson(pkg: Pkg): Record<string, unknown> {
  const { scripts: _s, devDependencies: _d, exports, ...rest } = pkg;
  return { ...rest, exports: distExports(exports), publishConfig: { access: 'public', provenance: true } };
}

if (import.meta.main) {
  rmSync(dist, { recursive: true, force: true });
  await $`bunx tsc -p ${join(root, 'tsconfig.build.json')}`;
  rewriteDist(dist);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pkg;
  for (const [, target] of Object.entries(pkg.exports)) {
    if (!target.startsWith('./src/') || target.endsWith('.ts')) continue;
    cpSync(join(root, target), join(dist, target.replace(/^\.\/src\//, '')));
  }
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
  }
  writeFileSync(join(dist, 'package.json'), `${JSON.stringify(distPackageJson(pkg), null, 2)}\n`);
  console.log(`built ${String(pkg.name)}@${String(pkg.version)} → ${dist}`);
}
