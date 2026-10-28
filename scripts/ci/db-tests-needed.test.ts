import { describe, expect, it } from 'bun:test';
import { decideDbTests, isDbSafePath } from './db-tests-needed';

const pr = (...changed: string[]) => decideDbTests({ event: 'pull_request', changed });

describe('decideDbTests', () => {
  it('pushes always run', () => {
    expect(decideDbTests({ event: 'push', changed: [] }).run).toBe(true);
    expect(decideDbTests({ event: 'push', changed: ['README.md'] }).run).toBe(true);
  });

  it('runs when it cannot tell what changed', () => {
    expect(decideDbTests({ event: 'pull_request', changed: null }).run).toBe(true);
    expect(pr().run).toBe(true);
  });

  it('skips a docs, styling or image only change, and says so', () => {
    const d = pr('docs/testing.md', 'apps/web/src/app/globals.css', 'apps/web/public/hero/a.png', '.claude/settings.json', 'README.md');
    expect(d.run).toBe(false);
    expect(d.reason).toStartWith('skipped: no server/DB code changed');
  });

  it('runs when any one file can matter', () => {
    for (const path of [
      'apps/web/src/lib/x.ts',
      'apps/web/src/app/page.tsx',
      'apps/web/tests/db/harness.ts',
      'apps/runner/src/workers.ts',
      'packages/core/db/schema.ts',
      'packages/core/drizzle/20261028000000_x/migration.sql',
      'packages/core/mcp-guidance/topic.md',
      'packages/shared/src/logo.svg',
      'scripts/run-db-tests.ts',
      'scripts/qa/scrub-pii.sql',
      'scripts/db-test-durations.json',
      '.github/workflows/build.yml',
      'package.json',
      'bun.lock',
      'docs/specs/task-page.md',
      '.claude/skills/buildd-mcp-consumer/SKILL.md',
    ]) {
      const d = pr('docs/testing.md', path);
      expect(d.run).toBe(true);
      expect(d.reason).toContain(path);
    }
  });
});

describe('isDbSafePath', () => {
  it('is an allowlist: unknown files are not safe', () => {
    expect(isDbSafePath('Dockerfile')).toBe(false);
    expect(isDbSafePath('apps/web/src/lib/x.json')).toBe(false);
    expect(isDbSafePath('turbo.json')).toBe(false);
  });
});
