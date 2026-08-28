import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Trigger coverage guard for docs/specs/external-cron-triggers.md.
 *
 * The spec's capability statement is that a route silently never firing should
 * be a reviewable diff rather than an invisible production gap — but nothing
 * actually checked it, and five routes sat on Vercel-native crons that were not
 * firing in this project. `/api/cron/codex-token-refresh` was one of them, which
 * is why an MCP connector credential with a perfectly good refresh token stayed
 * dead for 15 days.
 */

const ROOT = resolve(import.meta.dir, '..');
const CRON_DIR = resolve(ROOT, 'apps/web/src/app/api/cron');

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'cron-manifest.json'), 'utf8')) as {
  jobs: { path: string; schedule: string; method?: string; enabled?: boolean }[];
};
const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
  crons?: { path: string; schedule: string }[];
};

/** Route directories that actually export a handler. */
const routes = readdirSync(CRON_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(resolve(CRON_DIR, d.name, 'route.ts')))
  .map(d => `/api/cron/${d.name}`);

const manifestPaths = new Set(manifest.jobs.map(j => j.path.split('?')[0]));
const vercelPaths = new Set((vercel.crons ?? []).map(c => c.path));

describe('cron trigger coverage', () => {
  it('finds the cron routes it is meant to guard', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('declares every cron route in exactly one source', () => {
    const untriggered = routes.filter(r => !manifestPaths.has(r) && !vercelPaths.has(r));
    const doubled = routes.filter(r => manifestPaths.has(r) && vercelPaths.has(r));
    expect(untriggered, 'routes with no trigger at all').toEqual([]);
    expect(doubled, 'routes that would fire twice').toEqual([]);
  });

  it('declares no job for a route that does not exist', () => {
    const known = new Set(routes);
    const orphans = [...manifestPaths, ...vercelPaths].filter(p => !known.has(p));
    expect(orphans, 'triggers pointing at a deleted route').toEqual([]);
  });

  it('keeps vercel.json crons empty — the mechanism does not fire in this project', () => {
    // Everything is driven by the external scheduler (cron-job.org) via
    // cron-manifest.json. Adding a Vercel cron here would silently never run.
    expect(vercel.crons ?? []).toEqual([]);
  });

  it('gives every manifest job a method the syncer can encode', () => {
    for (const j of manifest.jobs) {
      expect(['GET', 'POST', undefined]).toContain(j.method);
    }
  });
});

describe('cron route auth', () => {
  it('accepts Bearer CRON_SECRET on every externally-triggered route', () => {
    // The external scheduler can only send `Authorization: Bearer $CRON_SECRET`.
    // A route that authenticates solely via `x-vercel-cron` would 401 forever.
    for (const path of manifestPaths) {
      const name = path.replace('/api/cron/', '');
      const src = readFileSync(resolve(CRON_DIR, name, 'route.ts'), 'utf8');
      expect(src, `${path} does not read CRON_SECRET`).toContain('CRON_SECRET');
    }
  });
});
