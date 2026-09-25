/**
 * Pages must not skip their data queries just because NODE_ENV is development.
 *
 * The `isDev` gates date from the first dashboard scaffold, when local dev had
 * no database. Keyed on NODE_ENV alone they kept `bun dev` blank even with a
 * real DATABASE_URL and DEV_USER_EMAIL (which getCurrentUser already honours),
 * so local QA could not see these pages. They now fire only when there is no
 * DATABASE_URL — the no-DB escape hatch the gates were written for.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = import.meta.dir;

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pageFiles(p);
    return name === 'page.tsx' ? [p] : [];
  });
}

const GATE = /const\s+isDev\s*=\s*process\.env\.NODE_ENV\s*===\s*'development'([^;]*);/;

describe('dev data gates: API', () => {
  // The new-task page reads its workspace list from here; empty in dev blocked it.
  const API = join(ROOT, '../../api/workspaces/route.ts');

  it('/api/workspaces short-circuits only when there is no DATABASE_URL', () => {
    const src = readFileSync(API, 'utf8');
    const gates = src.split('\n').filter((l) => l.includes("process.env.NODE_ENV === 'development'"));
    expect(gates.length).toBeGreaterThan(0);
    for (const line of gates) expect(line).toContain('!process.env.DATABASE_URL');
  });
});

describe('dev data gates', () => {
  const gated = pageFiles(ROOT)
    .map((file) => ({ file: file.slice(ROOT.length + 1), m: readFileSync(file, 'utf8').match(GATE) }))
    .filter((g) => g.m);

  it('finds the gated pages (guards against this test matching nothing)', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(['home/page.tsx', 'tasks/page.tsx', 'workspaces/page.tsx'])('%s is among them', (f) => {
    expect(gated.map((g) => g.file)).toContain(f);
  });

  it('every isDev gate also requires DATABASE_URL to be absent', () => {
    const nodeEnvOnly = gated.filter((g) => !/!\s*process\.env\.DATABASE_URL/.test(g.m![1])).map((g) => g.file);
    expect(nodeEnvOnly).toEqual([]);
  });
});
