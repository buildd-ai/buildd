import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, posix } from 'path';

// The workflow kernel is a library another product embeds, so it may import
// nothing of buildd's: no workspace package (core, shared, ai-kit), no database
// driver, no app alias, no Next.js, no Node built-in (WebCrypto, not
// node:crypto), no relative path that climbs out of the package.
// docs/specs/workflow-kernel-library.md §2, AC-5 and AC-8.

const REPO = join(import.meta.dir, '../../..');
const PKG = 'packages/workflow-kernel';

/** Every module specifier a file names: static, side-effect, re-export, dynamic and require. */
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"]([^'"]+)['"]/g;
/** Specifiers that are never allowed, wherever the file sits. */
const FORBIDDEN = /^(?:@buildd\/|@builddai\/|drizzle-orm(?:\/|$)|@neondatabase\/|@\/|next(?:\/|$)|node:)/;

/** The import a file at `file` may not make, or null when it stays inside the package. */
function offendingImport(file: string, spec: string): string | null {
  if (FORBIDDEN.test(spec)) return spec;
  if (spec.startsWith('.')) {
    const resolved = posix.normalize(posix.join(dirname(file), spec));
    if (resolved !== PKG && !resolved.startsWith(`${PKG}/`)) return spec;
  }
  return null;
}

function offendersIn(file: string, text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((m) => offendingImport(file, m[1]!)).filter((s): s is string => s != null).map((s) => `${file} → ${s}`);
}

function sources(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', PKG], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('no-buildd-imports.test.ts'));
}

describe('the workflow kernel imports nothing from buildd', () => {
  it('the pattern can fail, and names the import', () => {
    const at = `${PKG}/src/effects.ts`;
    expect(offendersIn(at, `import { db } from '@buildd/core/db';`)).toEqual([`${at} → @buildd/core/db`]);
    expect(offendersIn(at, `import type { Task } from "@buildd/shared";`)).toHaveLength(1);
    expect(offendersIn(at, `import { x } from '@builddai/ai-kit';`)).toHaveLength(1);
    expect(offendersIn(at, `import { sql } from 'drizzle-orm';`)).toHaveLength(1);
    expect(offendersIn(at, `import { neon } from '@neondatabase/serverless';`)).toHaveLength(1);
    expect(offendersIn(at, `import 'drizzle-orm';`)).toHaveLength(1);
    expect(offendersIn(at, `const m = await import('@buildd/core/verification-check')`)).toHaveLength(1);
    expect(offendersIn(at, `import { announce } from '@/lib/pusher';`)).toHaveLength(1);
    expect(offendersIn(at, `import { headers } from 'next/headers';`)).toHaveLength(1);
    expect(offendersIn(at, `import { randomUUID } from 'node:crypto';`)).toHaveLength(1);
    expect(offendersIn(at, `const fs = require('node:fs');`)).toHaveLength(1);
    expect(offendersIn(at, `import { x } from '../../core/db';`)).toEqual([`${at} → ../../core/db`]);
    expect(offendersIn(`${PKG}/src/conformance/x.ts`, `import { x } from '../../../apps/web/src/lib/pusher';`)).toHaveLength(1);
    // Inside the package is fine, including a subdirectory reaching back up.
    expect(offendersIn(at, `import { reduce } from './reducer';`)).toEqual([]);
    expect(offendersIn(`${PKG}/src/conformance/harness.ts`, `import { reduce } from '../reducer';`)).toEqual([]);
    expect(offendersIn(at, `import { describe } from 'bun:test';`)).toEqual([]);
  });

  it('scans a non-empty set', () => {
    const files = sources();
    expect(files).toContain(`${PKG}/src/reducer.ts`);
    expect(files).toContain(`${PKG}/src/conformance/conformance.test.ts`);
  });

  it('no tracked file imports a buildd package, a database driver, Next.js, a Node built-in or a path outside the package', () => {
    const offenders = sources().flatMap((p) => offendersIn(p, readFileSync(join(REPO, p), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('declares no dependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, PKG, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps).toEqual([]);
  });
});
