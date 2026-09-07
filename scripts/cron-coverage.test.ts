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
    // A route that authenticates solely via a platform cron header would 401
    // forever — and, worse, would admit anyone able to set that header, since
    // platform-native cron does not fire in this project at all.
    //
    // Two ways to satisfy this now: read the secret directly, or delegate to
    // `withCronRun`, which does nothing else. The check moved with the code; the
    // invariant did not change.
    for (const path of manifestPaths) {
      const name = path.replace('/api/cron/', '');
      const src = readFileSync(resolve(CRON_DIR, name, 'route.ts'), 'utf8');
      const readsSecret = src.includes('CRON_SECRET');
      const delegates = /from '@\/lib\/cron-run'/.test(src) && /\bwithCronRun\(/.test(src);
      expect(
        readsSecret || delegates,
        `${path} neither reads CRON_SECRET nor delegates to withCronRun`,
      ).toBe(true);
    }
  });

  it('no route trusts a platform cron header', () => {
    // `vercel.json` declares no crons and cron-manifest.json states the
    // platform mechanism does not fire here, so such a header can only come
    // from a caller that is not the scheduler. Two routes used to accept one in
    // place of the secret.
    const offenders = [...manifestPaths].filter(path => {
      const name = path.replace('/api/cron/', '');
      const src = readFileSync(resolve(CRON_DIR, name, 'route.ts'), 'utf8');
      // Only a real read of the header counts; the string appears in prose
      // explaining why it is not used.
      return /headers\.get\(\s*['"]x-vercel-cron['"]/.test(src);
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * A manifest entry with `enabled: false` satisfies every check above — the route
 * has a trigger, the trigger is not doubled, it is not an orphan — while never
 * firing. That is how JWKS rotation sat staged dark from the day it shipped:
 * signing keys never rotated, and no test, log or alert said so.
 *
 * Staging a route dark is legitimate. Staging it dark INVISIBLY is not. So the
 * set is enumerated here with a reason, and it may only shrink.
 */
describe('cron staged-dark ledger', () => {
  // Each entry must say why it does not fire, and what would change that.
  const STAGED_DARK: Record<string, string> = {
    '/api/cron/stall-notify':
      'BT-11/BT-19 stall notification. Never triggered. Enable once the ' +
      'notification volume is known to be tolerable at a 5-minute cadence.',
    '/api/cron/routing-calibration':
      'Aggregates 7 days of task outcomes for model-routing calibration. ' +
      'Read-only; its inputs (downshifted, wasRetried) are genuinely written, ' +
      'so it is enable-when-wanted rather than blocked on anything.',
  };

  const disabled = manifest.jobs
    .filter((j) => j.enabled === false)
    .map((j) => j.path)
    .sort();

  it('every dark job is listed with a reason', () => {
    const unexplained = disabled.filter((p) => !STAGED_DARK[p]);
    expect(
      unexplained,
      'a job was disabled without an entry here — say why it does not fire, ' +
        'or enable it. A silently dark cron is indistinguishable from a broken one.',
    ).toEqual([]);
  });

  it('the ledger names no job that is already enabled', () => {
    const stale = Object.keys(STAGED_DARK).filter((p) => !disabled.includes(p));
    expect(
      stale,
      'these jobs now fire — remove them from STAGED_DARK so the ledger keeps ' +
        'measuring something',
    ).toEqual([]);
  });

  it('the dark set only shrinks', () => {
    // Was 3 when this ledger landed; JWKS rotation was enabled in the same
    // change. Raising this number requires editing the line and explaining why.
    expect(disabled.length).toBeLessThanOrEqual(2);
  });
});
