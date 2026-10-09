import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import nextConfig, { SETTINGS_ROUTE_MOVES } from '../../next.config.mjs';

/**
 * One Settings: every page that moved into it keeps resolving at its old path
 * (a next.config redirect), the new home exists, and the old page file is gone
 * so nothing renders a second copy of the same concern.
 */

const PROTECTED = resolve(import.meta.dir, '../app/app/(protected)');
/** `/app/settings/roles/:slug` → `settings/roles/[slug]/page.tsx` (any `:param` name maps to its bracket dir). */
function pageFile(path: string, params: Record<string, string> = {}): string {
  const rel = path.split('?')[0].replace(/^\/app\//, '').split('/')
    .map((seg) => (seg.startsWith(':') ? `[${params[seg.slice(1)] ?? seg.slice(1)}]` : seg))
    .join('/');
  return resolve(PROTECTED, rel, 'page.tsx');
}

// old path → [new path, the param dir names on the new side]
const EXPECTED: Array<[string, string, Record<string, string>?]> = [
  ['/app/team', '/app/settings/roles'],
  ['/app/team/new', '/app/settings/roles/new'],
  ['/app/team/:slug/settings', '/app/settings/roles/:slug/edit'],
  ['/app/team/:slug', '/app/settings/roles/:slug'],
  ['/app/workspaces/:id/skills', '/app/settings/roles'],
  ['/app/teams/new', '/app/settings/team/new'],
  ['/app/teams/:id', '/app/settings/team?team=:id'],
  ['/app/accounts/new', '/app/settings/runners/tokens/new'],
  ['/app/workspaces/:id/runners', '/app/health/runners?workspace=:id'],
  ['/app/settings/providers', '/app/settings/models'],
  ['/app/settings/ai', '/app/settings/models'],
  ['/app/workspaces', '/app/settings/workspaces'],
  ['/app/workspaces/new', '/app/settings/workspaces/new'],
  ['/app/workspaces/:id/config', '/app/settings/workspace/:id', { id: 'workspaceId' }],
];

describe('settings route moves', () => {
  it('redirects every moved route to its new home', async () => {
    const redirects = await nextConfig.redirects!();
    for (const [source, destination] of EXPECTED) {
      const r = redirects.find((x) => x.source === source);
      expect(r ? `${source} → ${r.destination}` : `${source} → (none)`).toBe(`${source} → ${destination}`);
      expect(r!.permanent).toBe(false);
    }
    expect(SETTINGS_ROUTE_MOVES).toHaveLength(EXPECTED.length);
  });

  it('matches a fixed segment before the param route beside it', () => {
    const order = SETTINGS_ROUTE_MOVES.map((m) => m.source);
    expect(order.indexOf('/app/team/new')).toBeLessThan(order.indexOf('/app/team/:slug'));
    expect(order.indexOf('/app/team/:slug/settings')).toBeLessThan(order.indexOf('/app/team/:slug'));
    expect(order.indexOf('/app/teams/new')).toBeLessThan(order.indexOf('/app/teams/:id'));
  });

  it('has a page at every new home', () => {
    for (const [, destination, params] of EXPECTED) {
      const file = pageFile(destination, params);
      expect(`${destination}: ${existsSync(file)}`).toBe(`${destination}: true`);
    }
  });

  it('removes the old page so nothing renders the same concern twice', () => {
    // A page.tsx at a redirected path is dead code that looks live:
    // config redirects run before the filesystem routes.
    for (const [source] of EXPECTED) {
      expect(`${source}: ${existsSync(pageFile(source))}`).toBe(`${source}: false`);
    }
  });

  it('sends a workspace-scoped role link to the one role editor', () => {
    // /app/workspaces/[id]/skills/[skillId] needs the skill's slug, so it is a
    // page-level redirect, not a config one; the old editor is gone.
    const page = readFileSync(resolve(PROTECTED, 'workspaces/[id]/skills/[skillId]/page.tsx'), 'utf8');
    expect(page).toContain('/app/settings/roles');
    expect(page).toMatch(/\bredirect\(/);
    expect(existsSync(resolve(PROTECTED, 'workspaces/[id]/skills/[skillId]/RoleEditor.tsx'))).toBe(false);
  });
});

describe('one editor per concern', () => {
  const exists = (rel: string) => existsSync(resolve(PROTECTED, rel));

  it('has one role editor', () => {
    expect(exists('settings/roles/[slug]/edit/TeamRoleEditor.tsx')).toBe(true);
    expect(exists('workspaces/[id]/skills/[skillId]/RoleEditor.tsx')).toBe(false);
    expect(exists('workspaces/[id]/skills/SkillForm.tsx')).toBe(false);
  });

  it('has one members page: the old team detail page is gone', () => {
    expect(exists('teams/[id]/page.tsx')).toBe(false);
    expect(exists('settings/team/page.tsx')).toBe(true);
  });

  it('has one per-workspace settings page holding what config used to', () => {
    expect(exists('workspaces/[id]/config/page.tsx')).toBe(false);
    const page = readFileSync(resolve(PROTECTED, 'settings/workspace/[workspaceId]/page.tsx'), 'utf8');
    for (const section of ['MergePolicyEditor', 'GitConfigForm', 'BranchStrategySection', 'CiRetrySection', 'ReleaseSection', 'ExecutorSection', 'ConcurrencySection', 'WorkTrackerSection']) {
      expect(`${section}: ${page.includes(section)}`).toBe(`${section}: true`);
    }
  });

  it('configures runners only in Settings › Runners', () => {
    // The workspace overview and config used to repeat runner setup.
    expect(exists('workspaces/[id]/connect-runner.tsx')).toBe(false);
    expect(exists('workspaces/[id]/runners/page.tsx')).toBe(false);
    const overview = readFileSync(resolve(PROTECTED, 'workspaces/[id]/page.tsx'), 'utf8');
    expect(overview).not.toContain('Accounts → New Account');
    expect(overview).not.toContain('ConnectRunnerSection');
  });

  it('keeps model config on one page: Models holds keys, sign-ins, tiers and features', () => {
    const models = readFileSync(resolve(PROTECTED, 'settings/models/page.tsx'), 'utf8');
    for (const part of ['ModelProvidersClient', 'AgentBackendsSection', 'ModelTiersClient', 'ModelFeatures']) {
      expect(`${part}: ${models.includes(part)}`).toBe(`${part}: true`);
    }
    const runners = readFileSync(resolve(PROTECTED, 'settings/runners/page.tsx'), 'utf8');
    expect(runners).not.toContain('AgentBackendsSection');
  });
});
