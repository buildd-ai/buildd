/**
 * Acceptance for spec "Parallelism limits: runner slots and mission cap only"
 * (revision 2). Written before the build, so every test here fails on the
 * starting commit and passes when the cut is whole.
 *
 * Most checks are about what is gone, so they read the tracked source: no
 * workspace cap, no mission pacing, no server model of a subscription. The
 * rest call the code that decides (the MCP actions, the runner-wall key).
 * Source scans skip tests, migrations (history stays history) and the
 * CHANGELOG; they read every other tracked file under apps/ and packages/.
 *
 * The runner halves (R-18, AC-5, AC-9) live in
 * apps/runner/__tests__/unit/parallelism-limits-*.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '../../packages/core/db/schema';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../../packages/core/mcp-tools';
import { resolveRunnerSeatWallKey } from '../../apps/web/src/lib/runner-seat-wall';

const ROOT = join(import.meta.dir, '..', '..');

const tracked: string[] = (() => {
  const out = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'apps', 'packages', 'docs/reports'], { cwd: ROOT });
  return new TextDecoder().decode(out.stdout).split('\0').filter(Boolean);
})();

const isTest = (p: string) =>
  /\.test\.tsx?$/.test(p) || /(^|\/)(__tests__|__snapshots__|tests)\//.test(p) || /\.snap$/.test(p);

/** Source worth scanning: tracked, still on disk, not a test or a migration. */
const source = tracked.filter(p =>
  /\.(tsx?|mjs|js|json|md)$/.test(p)
  && !isTest(p)
  && !p.startsWith('packages/core/drizzle/')
  && !/CHANGELOG/i.test(p)
  && existsSync(join(ROOT, p)));

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function hits(pattern: RegExp, files: string[] = source): string[] {
  const found: string[] = [];
  for (const p of files) {
    const text = read(p);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

const under = (...prefixes: string[]) => source.filter(p => prefixes.some(x => p.startsWith(x)));
const gone = (p: string) => expect(existsSync(join(ROOT, p)), `${p} still exists`).toBe(false);

// A drizzle table carries its columns as own string keys and its SQL name under a symbol.
const TABLE_NAME = Symbol.for('drizzle:Name');
const columnsOf = (table: unknown) => Object.keys(table as object);
const tableNames = () =>
  Object.values(schema as Record<string, unknown>)
    .filter((v): v is Record<symbol, string> => !!v && typeof v === 'object' && typeof (v as Record<symbol, unknown>)[TABLE_NAME] === 'string')
    .map(v => v[TABLE_NAME]);

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const ctx: ActionContext = {
  workspaceId: WORKSPACE_ID,
  getWorkspaceId: async () => WORKSPACE_ID,
  getLevel: async () => 'admin',
};

/** Run an MCP action against a recording api; report whether it threw and which bodies it sent. */
async function callMcp(tool: string, params: Record<string, unknown>) {
  const sent: unknown[] = [];
  const api = (async (_endpoint: string, opts?: RequestInit) => {
    if (opts?.body) sent.push(JSON.parse(String(opts.body)));
    return { id: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: 'w', repo: 'o/r' }], title: 't', status: 'active' };
  }) as unknown as ApiFn;
  let threw = false;
  try { await handleBuilddAction(api, tool, params, ctx); } catch { threw = true; }
  return { threw, sent };
}

describe('Workspace cap', () => {
  test('R-1: no claim defers for workspace_cap and the reason exists nowhere', () => {
    gone('apps/web/src/app/api/workers/claim/workspace-cap-gate.ts');
    expect(hits(/workspace_cap/)).toEqual([]);
  });

  test('R-2: no surface shows or edits a workspace cap', () => {
    gone('apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/ConcurrencySection.tsx');
    const ui = under('apps/web/src');
    expect(hits(/Max concurrent tasks|Raise the workspace limit/i, ui)).toEqual([]);
    // The Start flow that raised the cap, and the workspace page that fed the section.
    expect(hits(/maxConcurrentTasks/, [
      'apps/web/src/components/tasks/useTaskStart.ts',
      'apps/web/src/app/api/tasks/[id]/start/route.ts',
      'apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/page.tsx',
      'apps/web/src/app/app/(protected)/home/page.tsx',
    ])).toEqual([]);
  });

  test('R-3: maxConcurrentTasks is gone from the workspaces table and the workspace API', () => {
    expect(columnsOf(schema.workspaces)).not.toContain('maxConcurrentTasks');
    expect(hits(/maxConcurrentTasks/, under('apps/web/src/app/api/workspaces', 'apps/web/src/lib/workspace-'))).toEqual([]);
  });
});

describe('Mission pacing', () => {
  test('R-5: no mission_paced deferral, no pacing field, no pacing columns', () => {
    gone('apps/web/src/app/api/workers/claim/pacing-gate.ts');
    expect(columnsOf(schema.missions)).not.toContain('pacingMode');
    expect(columnsOf(schema.missions)).not.toContain('pacingMaxPerHour');
    expect(hits(/mission_paced|pacingMode|pacingMaxPerHour/)).toEqual([]);
  });

  test('R-6: pacing is never offered in the UI', () => {
    // Surfaces a person reads or edits: dashboard pages, components, the chat
    // field labels and the runner's terminal views. (Budget pacing of API-key
    // spend is a different thing and stays.)
    const ui = under('apps/web/src/app/app', 'apps/web/src/components', 'apps/web/src/lib/chat', 'apps/runner/src/top');
    expect(hits(/pacingMode|pacingMaxPerHour|mission_paced|\bPacing\b|mission is paced|\bpaced\b/, ui)).toEqual([]);
  });
});

describe('Subscription parallelism', () => {
  test('R-9: the server keeps no model of a subscription', () => {
    gone('packages/core/oauth-budget.ts');
    gone('apps/web/src/lib/oauth-budget-window.ts');
    expect(Object.keys(schema)).not.toContain('oauthBudgetEpisodes');
    expect(tableNames()).not.toContain('oauth_budget_episodes');
    expect(hits(/oauth_parallelism|OAUTH_BUDGET_PACING/)).toEqual([]);
    const claim = read('apps/web/src/app/api/workers/claim/route.ts');
    expect(claim).not.toMatch(/oauth-budget|oauthBudget|oauthPressure/);
  });

  test('R-10: a subscription limit wall holds only the runner whose login hit it, even when the team stores a credential', async () => {
    const decision = await resolveRunnerSeatWallKey(
      {
        backend: 'claude',
        error: "You've hit your session limit · resets 2pm",
        runner: 'dev-box',
        claimedByCloud: false,
        tenantId: null,
        accountId: 'acct-1',
        teamId: 'team-1',
        workspaceId: 'ws-1',
      },
      {
        heartbeatModelAuthSource: async () => 'machine_login',
        // The team keeps a Claude credential and an endpoint: today that makes
        // the wall "shared" and holds every runner of the team.
        teamClaudeCredentialVisible: async () => true,
        teamEndpointWins: async () => true,
      },
    );
    expect(decision.seatKey).not.toBeNull();
  });

  test('R-19: nothing estimates, learns or stores a subscription capacity, usage curve or limit history', () => {
    expect(tableNames().filter(n => /episode|capacity|usage_curve/i.test(n))).toEqual([]);
    expect(hits(/learnOauthCapacity|oauthBudgetPressure|OauthEpisode|learned_exhaustion_floor|loadOauthEpisodes|measureOauthWindow/)).toEqual([]);
  });
});

describe('Copy', () => {
  test('R-11: no copy talks about managing, pacing or pooling a subscription', () => {
    const copyFiles = under('apps/web/src', 'apps/runner/src', 'packages/shared/src');
    expect(hits(/the plan allows only a few sessions|subscription is at its session limit/i, copyFiles)).toEqual([]);
    expect(hits(/\b(pac(e|es|ed|ing)|pool(s|ed|ing)?|manag(e|es|ed|ing))\b[^'"`\n]{0,30}\b(subscriptions?|seats?|logins?)\b/i, copyFiles.filter(p => /\.tsx?$/.test(p)))).toEqual([]);
  });
});

describe('Unknown fields', () => {
  test('AC-3: manage_workspaces update { maxConcurrentTasks } fails like any unknown field, and the column is gone', async () => {
    const bogus = await callMcp('manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, bogusUnknownField: 5 });
    const cap = await callMcp('manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, maxConcurrentTasks: 5 });
    expect(JSON.stringify(cap.sent)).not.toContain('maxConcurrentTasks');
    expect(cap.threw).toBe(bogus.threw);
    expect(columnsOf(schema.workspaces)).not.toContain('maxConcurrentTasks');
  });

  test('AC-3: manage_missions update { pacingMode } fails like any unknown field, and the columns are gone', async () => {
    const bogus = await callMcp('manage_missions', { action: 'update', missionId: WORKSPACE_ID, bogusUnknownField: 'x' });
    const paced = await callMcp('manage_missions', { action: 'update', missionId: WORKSPACE_ID, pacingMode: 'paced' });
    expect(JSON.stringify(paced.sent)).not.toContain('pacingMode');
    expect(paced.threw).toBe(bogus.threw);
    expect(columnsOf(schema.missions)).not.toContain('pacingMode');
    expect(columnsOf(schema.missions)).not.toContain('pacingMaxPerHour');
    // The mission cap stays (R-7).
    expect(columnsOf(schema.missions)).toContain('maxConcurrentTasks');
  });
});

describe('Nothing named for OAuth budget remains', () => {
  test('AC-10: no file, table or field named for OAuth budget, capacity, pressure or episodes; the forecast has no learned figure', () => {
    const named = tracked.filter(p => /oauth[-_]?(budget|window|capacity|pressure|episode)/i.test(p) && !isTest(p) && !p.startsWith('packages/core/drizzle/'));
    expect(named).toEqual([]);
    expect(tableNames().filter(n => /oauth.*(budget|episode)/i.test(n))).toEqual([]);
    expect(hits(/oauth[-_]?budget|oauthBudget|OauthBudget|oauth_budget_episodes|oauthEpisode|oauthSessions|pressurePct|learned_exhaustion_floor|forecast floor pressure/i)).toEqual([]);
  });
});
