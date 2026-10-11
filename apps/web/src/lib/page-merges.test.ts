import { describe, expect, it } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';
import nextConfig, { PAGE_MERGES } from '../../next.config.mjs';

/**
 * Screen inventory merges (one page per job): every retired route keeps
 * resolving through a next.config redirect, its new home exists, and the old
 * page file is gone so nothing renders the same thing twice.
 */

const PROTECTED = resolve(import.meta.dir, '../app/app/(protected)');
const pageFile = (path: string) => resolve(PROTECTED, path.split(/[?#]/)[0].replace(/^\/app\//, ''), 'page.tsx');

// old path → new path (pages merged into another, and redirect-only pages)
const EXPECTED: Array<[string, string]> = [
  ['/app/settings/github', '/app/settings/integrations'],
  ['/app/settings/storage', '/app/settings/integrations'],
  ['/app/settings/budgets', '/app/settings/billing'],
  ['/app/settings/connectors', '/app/settings/connections'],
  ['/app/tasks/new', '/app/chat?new=task'],
  ['/app/workers', '/app/tasks'],
  ['/app/artifacts', '/app/missions'],
  ['/app/insights', '/app/health/insights'],
  ['/app/initiatives/new', '/app/missions'],
  ['/app/initiatives/:id', '/app/missions?group=:id'],
  ['/app/initiatives', '/app/missions'],
];

describe('page merges', () => {
  it('redirects every retired route to its new home', async () => {
    const redirects = (await nextConfig.redirects!()).filter((r) => !r.has);
    for (const [source, destination] of EXPECTED) {
      const r = redirects.find((x) => x.source === source);
      expect(r ? `${source} → ${r.destination}` : `${source} → (none)`).toBe(`${source} → ${destination}`);
      expect(r!.permanent).toBe(false);
    }
  });

  it('keeps the workspace an old new-task link named', async () => {
    const redirects = await nextConfig.redirects!();
    const all = redirects.filter((r) => r.source === '/app/tasks/new');
    const scoped = all.find((r) => r.has);
    expect(scoped?.has).toEqual([{ type: 'query', key: 'workspaceId', value: '(?<ws>[^&]+)' }]);
    expect(scoped?.destination).toBe('/app/chat?new=task&ws=:ws');
    // The scoped rule must come first: the first match wins.
    expect(all.indexOf(scoped!)).toBe(0);
  });

  it('sends the old top-level connections link and the OAuth callback to Connected apps', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.find((r) => r.source === '/app/connections')?.destination).toBe('/app/settings/connections');
  });

  it('has a page at every new home', () => {
    for (const [, destination] of EXPECTED) {
      expect(`${destination}: ${existsSync(pageFile(destination))}`).toBe(`${destination}: true`);
    }
  });

  it('removes the old page so nothing renders the same concern twice', () => {
    for (const [source] of EXPECTED) {
      expect(`${source}: ${existsSync(pageFile(source))}`).toBe(`${source}: false`);
    }
  });

  it('deletes the three Initiatives page files', () => {
    for (const f of ['initiatives/page.tsx', 'initiatives/[id]/page.tsx', 'initiatives/new/page.tsx']) {
      expect(`${f}: ${existsSync(resolve(PROTECTED, f))}`).toBe(`${f}: false`);
    }
  });

  it('lists only rules this file checks', () => {
    const sources = new Set(EXPECTED.map(([s]) => s));
    for (const m of PAGE_MERGES) expect(`${m.source}: ${sources.has(m.source)}`).toBe(`${m.source}: true`);
  });
});
