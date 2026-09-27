import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distExports, distPackageJson, rewriteRelativeSpecifiers } from './build';
import pkg from '../package.json';

describe('dist package.json', () => {
  it('maps every source export to compiled ESM + .d.ts', () => {
    const out = distExports(pkg.exports) as Record<string, unknown>;
    expect(out['./chat/contract']).toEqual({ types: './chat/contract/index.d.ts', import: './chat/contract/index.js' });
    expect(out['./chat/theme.css']).toBe('./chat/theme.css');
    expect(Object.keys(out).sort()).toEqual(Object.keys(pkg.exports).sort());
  });
  it('has the entry points the design names', () => {
    for (const e of ['./models', './decide', './chat/contract', './chat/server', './chat/react', './chat/theme.css', './surfaces']) {
      expect(pkg.exports).toHaveProperty([e]);
    }
  });
  it('publishes public with provenance, with no dev-only fields', () => {
    const out = distPackageJson(pkg as never);
    expect(out.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(out).not.toHaveProperty('scripts');
    expect(out).not.toHaveProperty('devDependencies');
    expect(out.name).toBe('@builddai/ai-kit');
    expect((out.repository as { url: string }).url).toContain('github.com/buildd-ai/buildd');
  });
  it('is an exact semver version, independent of buildd', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('relative import specifiers', () => {
  // Source uses extensionless relative imports so a bundler consuming the kit
  // from source (Next/Turbopack via workspace, which does NOT map `./x.js` to
  // `./x.ts`) and a plain `tsc` (bundler resolution) both resolve them with no
  // consumer config. The build then rewrites them to real `.js` paths so the
  // published dist is valid Node ESM.
  const srcDir = join(import.meta.dir, '..', 'src');
  const sourceFiles = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('source never uses a .js or .ts extension on a relative import', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles) {
      const code = readFileSync(join(srcDir, f), 'utf8');
      for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g)) {
        if (/\.(?:[cm]?js|[cm]?ts|tsx?)$/.test(m[2])) offenders.push(`${f}: ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  const files = new Set(['/d/models/types.js', '/d/models/client.js', '/d/chat/contract/index.js']);
  const exists = (p: string) => files.has(p);

  it('rewrites file and directory specifiers to Node ESM paths', () => {
    const code = [
      "export * from './types';",
      "import { a } from \"./client\";",
      "import type { C } from '../chat/contract';",
      "export type T = import('./types').X;",
      "import './types';",
    ].join('\n');
    expect(rewriteRelativeSpecifiers(code, '/d/models', exists)).toBe([
      "export * from './types.js';",
      "import { a } from \"./client.js\";",
      "import type { C } from '../chat/contract/index.js';",
      "export type T = import('./types.js').X;",
      "import './types.js';",
    ].join('\n'));
  });

  it('leaves bare and already-extensioned specifiers alone', () => {
    const code = "import x from '@typesafe-ai/sdk';\nimport y from './types.js';\nimport './theme.css';";
    expect(rewriteRelativeSpecifiers(code, '/d/models', exists)).toBe(code);
  });

  it('fails loudly on a specifier it cannot resolve', () => {
    expect(() => rewriteRelativeSpecifiers("import { z } from './missing';", '/d/models', exists))
      .toThrow(/\.\/missing/);
  });
});
