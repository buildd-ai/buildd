import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditBareImports, distExports, distPackageJson, packageOf, rewriteRelativeSpecifiers } from './build';
import pkg from '../package.json';

describe('dist package.json', () => {
  it('maps every source export to compiled ESM + .d.ts', () => {
    const out = distExports(pkg.exports) as Record<string, unknown>;
    expect(out['./chat/contract']).toEqual({ types: './chat/contract/index.d.ts', import: './chat/contract/index.js' });
    expect(out['./chat/theme.css']).toBe('./chat/theme.css');
    expect(Object.keys(out).sort()).toEqual(Object.keys(pkg.exports).sort());
  });
  it('has the entry points the design names', () => {
    for (const e of ['./models', './policy', './decide', './chat/contract', './chat/server', './chat/react', './chat/theme.css', './chat/styles.css', './chat/schema.sql', './surfaces']) {
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
    .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

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

describe('bare imports reach the consumer', () => {
  const kit = {
    name: '@builddai/ai-kit',
    dependencies: { dep: '1.0.0' },
    peerDependencies: { '@typesafe-ai/sdk': '0.6.0', react: '^19.0.0' },
    peerDependenciesMeta: { '@typesafe-ai/sdk': { optional: true } },
  };
  it('names the package of a specifier', () => {
    expect(packageOf('@typesafe-ai/sdk/sub')).toBe('@typesafe-ai/sdk');
    expect(packageOf('react/jsx-runtime')).toBe('react');
    expect(packageOf('node:fs')).toBeNull();
  });
  it('flags a static import of an optional peer (0.1.0 /decide) and an undeclared package', () => {
    const problems = auditBareImports({
      'decide/index.js': "import { TypeSafeClient } from '@typesafe-ai/sdk';",
      'chat/react/index.js': "import { jsx } from 'react/jsx-runtime';\nimport x from 'left-pad';",
    }, kit);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("statically imports optional peer '@typesafe-ai/sdk'");
    expect(problems[1]).toContain("'left-pad'");
  });
  it('allows deps, required peers, self-references, node: and a lazy optional peer', () => {
    expect(auditBareImports({
      'a.js': [
        "import d from 'dep';",
        "import { useState } from 'react';",
        "export * from '@builddai/ai-kit/chat/contract';",
        "import { readFileSync } from 'node:fs';",
        "const sdk = await import('@typesafe-ai/sdk');",
      ].join('\n'),
    }, kit)).toEqual([]);
  });
  it('lets /chat/react (and only it) import its optional peers statically', () => {
    const optional = {
      ...kit,
      peerDependencies: { ...kit.peerDependencies, ai: '^7.0.0', '@ai-sdk/react': '^4.0.0' },
      peerDependenciesMeta: { ...kit.peerDependenciesMeta, react: { optional: true }, ai: { optional: true }, '@ai-sdk/react': { optional: true } },
    };
    expect(auditBareImports({
      'chat/react/index.js': "import { jsx } from 'react/jsx-runtime';\nimport { useChat } from '@ai-sdk/react';\nimport { DefaultChatTransport } from 'ai';",
    }, optional)).toEqual([]);
    const problems = auditBareImports({ 'chat/server/turn.js': "import { streamText } from 'ai';" }, optional);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("statically imports optional peer 'ai'");
    expect(auditBareImports({ 'chat/server/turn.js': "const ai = await import('ai');" }, optional)).toEqual([]);
  });
  it('carries the optional peer into dist/package.json', () => {
    const out = distPackageJson(pkg as never) as { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional: boolean }> };
    expect(out.peerDependencies['@typesafe-ai/sdk']).toBe(pkg.devDependencies['@typesafe-ai/sdk']);
    expect(out.peerDependenciesMeta['@typesafe-ai/sdk']).toEqual({ optional: true });
  });
});
