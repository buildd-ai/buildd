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
/**
 * Allowlist, not denylist: a file may import only a relative path that stays
 * inside the package, or `bun:test` from a test file. Everything else is an
 * offender: a buildd package, a database driver, the app alias, Next.js, a Node
 * built-in with or without the `node:` prefix (`crypto`, `fs`), and any bare
 * npm package, which would resolve from the shared node_modules even though
 * the package declares no dependency.
 */
function offendingImport(file: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const resolved = posix.normalize(posix.join(dirname(file), spec));
    return resolved === PKG || resolved.startsWith(`${PKG}/`) ? null : spec;
  }
  if (spec === 'bun:test' && /\.test\.tsx?$/.test(file)) return null;
  return spec;
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
    expect(offendersIn(`${PKG}/src/reducer.test.ts`, `import { describe } from 'bun:test';`)).toEqual([]);
    // Bare built-ins and undeclared npm packages are offenders too.
    expect(offendersIn(at, `import { randomUUID } from 'crypto';`)).toEqual([`${at} → crypto`]);
    expect(offendersIn(at, `import { readFileSync } from 'fs';`)).toHaveLength(1);
    expect(offendersIn(at, `import { z } from 'zod';`)).toEqual([`${at} → zod`]);
    expect(offendersIn(at, `import { describe } from 'bun:test';`)).toHaveLength(1);
  });

  it('scans a non-empty set', () => {
    const files = sources();
    expect(files).toContain(`${PKG}/src/reducer.ts`);
    expect(files).toContain(`${PKG}/src/conformance/conformance.test.ts`);
  });

  it('no tracked file imports anything but a path inside the package (and bun:test in tests)', () => {
    const offenders = sources().flatMap((p) => offendersIn(p, readFileSync(join(REPO, p), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('declares no dependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, PKG, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps).toEqual([]);
  });
});
