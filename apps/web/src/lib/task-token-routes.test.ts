/**
 * Guard: every route that accepts a per-task token also confines it.
 *
 * `authenticateTaskScopedCaller` hands back the minting account with a
 * `taskScope`; nothing stops a route from then treating it like the account
 * key. So each route file that calls it must also apply a scope check
 * (`taskScopeAllowsTask` / `taskScopeAllowsWorker` / `taskScopeAllowsWorkspace` /
 * `taskScopeAllowsWorkerPr` / `taskScopeAllowsMission` / `taskScopeAllowsInitiative` /
 * `taskScopeAllowsMissionTask` / `taskScopeAllowsMissionTaskRead` / `taskScopeAllowsDelegated` (a schedule's
 * explicit delegation, packages/core/token-delegation.ts),
 * a direct read of `.taskScope`, or `authorizeWorkerPrCapability`, which
 * applies `taskScopeAllowsWorker` itself and is tested for it in
 * lib/agent-capabilities/worker-pr.test.ts), and each exported handler that calls it
 * directly must do so in its own body. The set of opted-in routes is pinned
 * too, so a new one is a reviewed decision rather than a side effect.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const REPO = join(import.meta.dir, '../../../..');
const SCOPE_CHECK = /taskScopeAllows(Task|Worker|Workspace|WorkerPr|Mission|Initiative|MissionTask|MissionTaskRead|Delegated)\(|\.taskScope\b|authorizeWorkerPrCapability\(/;

const OPTED_IN = [
  'apps/web/src/app/api/artifacts/[artifactId]/route.ts',
  'apps/web/src/app/api/artifacts/upload-url/route.ts',
  'apps/web/src/app/api/connectors/mounted/route.ts',
  'apps/web/src/app/api/decisions/route.ts',
  'apps/web/src/app/api/discrepancies/[id]/route.ts',
  'apps/web/src/app/api/discrepancies/route.ts',
  'apps/web/src/app/api/evidence/route.ts',
  'apps/web/src/app/api/experiments/[id]/route.ts',
  'apps/web/src/app/api/experiments/route.ts',
  'apps/web/src/app/api/explain/route.ts',
  'apps/web/src/app/api/github/pr/review/route.ts',
  'apps/web/src/app/api/github/pr/route.ts',
  'apps/web/src/app/api/github/pr/supersede/route.ts',
  'apps/web/src/app/api/health/dispatch/route.ts',
  'apps/web/src/app/api/health/failures/route.ts',
  'apps/web/src/app/api/initiatives/[id]/artifacts/route.ts',
  'apps/web/src/app/api/mcp/route.ts',
  'apps/web/src/app/api/missions/[id]/artifacts/route.ts',
  'apps/web/src/app/api/missions/[id]/evaluate/route.ts',
  'apps/web/src/app/api/missions/[id]/notes/route.ts',
  'apps/web/src/app/api/missions/[id]/route.ts',
  'apps/web/src/app/api/prs/route.ts',
  'apps/web/src/app/api/releases/[id]/route.ts',
  'apps/web/src/app/api/releases/route.ts',
  'apps/web/src/app/api/stats/coordination/route.ts',
  'apps/web/src/app/api/stats/usage/route.ts',
  'apps/web/src/app/api/tasks/[id]/approve-plan/route.ts',
  'apps/web/src/app/api/tasks/[id]/error-traces/route.ts',
  'apps/web/src/app/api/tasks/[id]/evidence/route.ts',
  'apps/web/src/app/api/tasks/[id]/messages/route.ts',
  'apps/web/src/app/api/tasks/[id]/notes/route.ts',
  'apps/web/src/app/api/tasks/[id]/reject-plan/route.ts',
  'apps/web/src/app/api/tasks/[id]/route.ts',
  'apps/web/src/app/api/tasks/route.ts',
  'apps/web/src/app/api/workers/[id]/artifacts/route.ts',
  'apps/web/src/app/api/workers/[id]/error-traces/route.ts',
  'apps/web/src/app/api/workers/[id]/evidence-upload-url/route.ts',
  'apps/web/src/app/api/workers/[id]/evidence/[evidenceId]/confirm/route.ts',
  'apps/web/src/app/api/workers/[id]/instruct/route.ts',
  'apps/web/src/app/api/workers/[id]/page-source/route.ts',
  'apps/web/src/app/api/workers/[id]/park/route.ts',
  'apps/web/src/app/api/workers/[id]/prompt-bundles/route.ts',
  'apps/web/src/app/api/workers/[id]/reattach/route.ts',
  'apps/web/src/app/api/workers/[id]/route.ts',
  'apps/web/src/app/api/workers/[id]/session-upload-url/route.ts',
  'apps/web/src/app/api/workers/active/route.ts',
  'apps/web/src/app/api/workers/claim/route.ts',
  'apps/web/src/app/api/workers/heartbeat/route.ts',
  'apps/web/src/app/api/workspaces/[id]/artifacts/route.ts',
  'apps/web/src/app/api/workspaces/[id]/config/route.ts',
  'apps/web/src/app/api/workspaces/[id]/error-traces/route.ts',
  'apps/web/src/app/api/workspaces/[id]/memory/route.ts',
  'apps/web/src/app/api/workspaces/[id]/schedules/[scheduleId]/route.ts',
  'apps/web/src/app/api/workspaces/[id]/schedules/route.ts',
  'apps/web/src/app/api/workspaces/route.ts',
];

function routesCallingIt(): string[] {
  const out = execSync("git grep -l 'authenticateTaskScopedCaller(' -- 'apps/web/src/app/**/route.ts'", { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

describe('routes that accept a per-task token', () => {
  const routes = routesCallingIt();

  it('are exactly the reviewed set', () => {
    expect(routes).toEqual([...OPTED_IN].sort());
  });

  for (const route of routes) {
    it(`${route} applies a scope check`, () => {
      const src = readFileSync(join(REPO, route), 'utf8');
      expect(SCOPE_CHECK.test(src)).toBe(true);
      // Each exported handler that authenticates with it directly checks scope in its own body.
      const handlers = src.split(/(?=export\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
      for (const body of handlers) {
        if (!body.includes('authenticateTaskScopedCaller(')) continue;
        const name = /function\s+(\w+)/.exec(body)?.[1];
        expect({ route, handler: name, checked: SCOPE_CHECK.test(body) }).toEqual({ route, handler: name, checked: true });
      }
    });
  }
});
