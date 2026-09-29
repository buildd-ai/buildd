import { describe, it, expect } from 'bun:test';
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
});
