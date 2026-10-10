import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'next/dist/compiled/json5';
import nextConfig from '../../next.config.mjs';

const webRoot = join(import.meta.dir, '../..');

// Next auto-externalizes every package on this list. Under `bun --bun next dev`
// (the CI visual-QA server and local dev) Turbopack loads such a package through
// a hashed alias (`@aws-sdk/client-s3-<hash>`) that Bun's resolver cannot find,
// so any page importing it — /app/tasks/[id] via lib/storage — renders a blank
// error boundary. Bundling it (transpilePackages) removes the alias entirely.
const defaultExternals: string[] = JSON5.parse(
  readFileSync(require.resolve('next/dist/lib/server-external-packages.jsonc', { paths: [webRoot] }), 'utf8'),
);

describe('next.config', () => {
  it('bundles every direct dependency Next would auto-externalize', () => {
    const pkg = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    const optedOut = new Set<string>(nextConfig.serverExternalPackages ?? []);
    const autoExternal = deps.filter(d => defaultExternals.includes(d) && !optedOut.has(d));

    expect(autoExternal).toContain('@aws-sdk/client-s3');
    for (const dep of autoExternal) {
      expect(nextConfig.transpilePackages).toContain(dep);
    }
  });

  // A devDependency is not in `dependencies`, so the check above misses it, yet
  // importing one from server code hits the same alias. lib/copy-review.ts
  // importing `typescript` 500'd every page that way. Check what source imports.
  it('bundles every auto-externalized package that server source imports', () => {
    const repoRoot = join(webRoot, '../..');
    const optedOut = new Set<string>(nextConfig.serverExternalPackages ?? []);
    const imported = new Set<string>();
    const specifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;
    for (const dir of ['apps/web/src', 'packages/core', 'packages/shared/src']) {
      for (const file of new Glob('**/*.{ts,tsx}').scanSync(join(repoRoot, dir))) {
        if (file.includes('node_modules') || file.includes('__tests__') || /\.test\.tsx?$/.test(file)) continue;
        for (const [, spec] of readFileSync(join(repoRoot, dir, file), 'utf8').matchAll(specifier)) {
          const parts = spec.split('/');
          imported.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
        }
      }
    }
    const autoExternal = [...imported].filter(p => defaultExternals.includes(p) && !optedOut.has(p));

    expect(autoExternal).toContain('typescript');
    for (const p of autoExternal) {
      expect(nextConfig.transpilePackages).toContain(p);
    }
  });
});
