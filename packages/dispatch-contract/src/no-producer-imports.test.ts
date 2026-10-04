import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Dispatch moves envelopes; Buildd decides what they mean. The contract (and
// the Dispatch Worker, apps/dispatch, when present) must not reach into
// Buildd's schema or database: no `@buildd/core` import, no drizzle.
// knowledge-base buildd/design/cloudflare-dispatch-transport.md, P0 tests.

const REPO = join(import.meta.dir, '../../..');
const FORBIDDEN = /from\s+['"](@buildd\/core(\/[^'"]*)?|@buildd\/shared(\/[^'"]*)?|drizzle-orm(\/[^'"]*)?|@neondatabase\/[^'"]+)['"]|import\(\s*['"]@buildd\/core/;

function sources(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'packages/dispatch-contract', 'apps/dispatch'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(p => /\.(ts|tsx)$/.test(p) && !p.endsWith('no-producer-imports.test.ts'));
}

describe('the Dispatch side imports nothing from Buildd', () => {
  it('the pattern can fail', () => {
    expect(FORBIDDEN.test(`import { db } from '@buildd/core/db';`)).toBe(true);
    expect(FORBIDDEN.test(`import { sql } from "drizzle-orm";`)).toBe(true);
    expect(FORBIDDEN.test(`const m = await import('@buildd/core/dispatch-outbox')`)).toBe(true);
    expect(FORBIDDEN.test(`import { signRequest } from '@buildd/dispatch-contract';`)).toBe(false);
  });

  it('scans a non-empty set', () => {
    expect(sources()).toContain('packages/dispatch-contract/src/envelope.ts');
  });

  it('no source imports Buildd core, its schema, or a database driver', () => {
    const offenders = sources().filter(p => FORBIDDEN.test(readFileSync(join(REPO, p), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
