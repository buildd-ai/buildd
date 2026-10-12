import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Living Specs' portable contract is what another product copies, so it may
// import nothing of buildd's: no workspace package (core, shared, ai-kit), no
// database driver, no app alias, no path that climbs out of the package.
// docs/specs/living-specs.md, "Portable contract".

const REPO = join(import.meta.dir, '../../..');
const SPEC = String.raw`['"]((?:@buildd|@builddai)\/[^'"]*|drizzle-orm(?:\/[^'"]*)?|@neondatabase\/[^'"]+|@\/[^'"]*|\.\.\/[^'"]*)['"]`;
const FORBIDDEN = new RegExp(String.raw`(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)` + SPEC);

function sources(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'packages/spec-contract'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('no-buildd-imports.test.ts'));
}

describe('the spec contract imports nothing from buildd', () => {
  it('the pattern can fail', () => {
    expect(FORBIDDEN.test(`import { db } from '@buildd/core/db';`)).toBe(true);
    expect(FORBIDDEN.test(`import type { Task } from "@buildd/shared";`)).toBe(true);
    expect(FORBIDDEN.test(`import { sql } from 'drizzle-orm';`)).toBe(true);
    expect(FORBIDDEN.test(`const m = await import('@buildd/core/verification-check')`)).toBe(true);
    expect(FORBIDDEN.test(`import { reach } from '@/lib/specs/store';`)).toBe(true);
    expect(FORBIDDEN.test(`import { x } from '../../core/db';`)).toBe(true);
    expect(FORBIDDEN.test(`import 'drizzle-orm';`)).toBe(true);
    expect(FORBIDDEN.test(`import { specCriteria } from './requirements';`)).toBe(false);
    expect(FORBIDDEN.test(`import { describe } from 'bun:test';`)).toBe(false);
  });

  it('scans a non-empty set', () => {
    expect(sources()).toContain('packages/spec-contract/src/outcome.ts');
  });

  it('no source imports a buildd package, a database driver or a path outside the package', () => {
    const offenders = sources().filter((p) => FORBIDDEN.test(readFileSync(join(REPO, p), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('declares no buildd dependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages/spec-contract/package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps).toEqual([]);
  });
});
