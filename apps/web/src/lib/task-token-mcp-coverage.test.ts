/**
 * Guard: every worker-level MCP action works for an agent holding a per-task
 * token, or says why not.
 *
 * Agents on cloud runners, and agents on self-hosted runners, call buildd MCP
 * with a per-task token (`bldt_`). The MCP route forwards each action to REST
 * routes with that same bearer, and a route refuses the token unless it is in
 * task-token-routes.test.ts's reviewed OPTED_IN set. So an action whose route
 * is not opted in is an action the agent is shown and cannot use.
 *
 * This reads each action's handler in packages/core/mcp-tools.ts, resolves
 * every `/api/...` path it calls to a route file, and requires each one to be
 * opted in, or listed below with the reason a task token must not reach it.
 * Reasons go stale too: an exemption for a route the action no longer calls,
 * or one that is now opted in, fails here.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { workerActions } from '@buildd/core/mcp-tools';

const REPO = join(import.meta.dir, '../../../..');
const API = 'apps/web/src/app/';

/** Actions a task token is refused outright, and why. */
const REFUSED_ACTIONS: Record<string, string> = {
  get_budget_forecast: 'team-wide by nature (team spend, seat pressure across accounts); cannot be narrowed to one workspace',
  suggest_schedule_update: 'writes a pending change to a workspace schedule, not to its own task or worker',
};

/**
 * Single calls inside an otherwise working action that a task token is refused
 * or never makes, and why.
 */
const REFUSED_CALLS: Record<string, Record<string, string>> = {
  manage_experiments: {
    'apps/web/src/app/api/experiments/[id]/readout/route.ts':
      'a readout counts tasks across every workspace on the team; narrowing it to one would change what it measures',
  },
  update_task: {
    'apps/web/src/app/api/workers/[id]/instruct/route.ts':
      'delivers an edited description to the task’s active worker; a task token edits only its own task, and that worker is itself, so delivery is skipped',
  },
  list_artifacts: {
    'apps/web/src/app/api/workspaces/route.ts': 'fallback lookup when no workspace is known; the MCP route pins a task token to its own workspace',
  },
  list_schedules: {
    'apps/web/src/app/api/workspaces/route.ts': 'fallback lookup when no workspace is known; the MCP route pins a task token to its own workspace',
  },
  trace_schedule: {
    'apps/web/src/app/api/workspaces/route.ts': 'fallback lookup when no workspace is known; the MCP route pins a task token to its own workspace',
  },
};

function trackedRoutes(): string[] {
  return execFileSync('git', ['ls-files', 'apps/web/src/app/api'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(f => f.endsWith('/route.ts'));
}

function optedIn(): Set<string> {
  const src = readFileSync(join(REPO, 'apps/web/src/lib/task-token-routes.test.ts'), 'utf8');
  const list = /const OPTED_IN = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
  return new Set([...list.matchAll(/'([^']+)'/g)].map(m => m[1]!));
}

/** The source of `case '<action>':` up to the next top-level case. */
function handlerSource(src: string, action: string): string {
  const start = src.indexOf(`case '${action}':`);
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {4}case '[a-z_]+':/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * The route file a path template hits. `${…}` is a wildcard segment; a
 * segment with text before it (`/pr${qs}`) keeps that text. Literal segments
 * beat `[param]` ones, as Next.js routing does.
 */
export function resolveRoute(template: string, routes: readonly string[]): string | null {
  const path = template.replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, '\u0000').replace(/\$\{.*$/, '\u0000');
  const segs = path.split('/').filter(Boolean).map(s => (s === '\u0000' ? '*' : s.replace(/\u0000.*$/, '')));
  let best: { file: string; literal: number } | null = null;
  for (const file of routes) {
    const parts = file.slice(API.length).replace(/\/route\.ts$/, '').split('/');
    if (parts.length !== segs.length) continue;
    let literal = 0;
    const ok = parts.every((p, i) => {
      if (p === segs[i]) { literal++; return true; }
      return p.startsWith('[') && p.endsWith(']');
    });
    if (ok && (!best || literal > best.literal)) best = { file, literal };
  }
  return best?.file ?? null;
}

function callsOf(action: string, src: string, routes: readonly string[]): string[] {
  const body = handlerSource(src, action);
  const templates = [...body.matchAll(/[`'"](\/api\/[^`'"\s]*)/g)].map(m => m[1]!);
  return [...new Set(templates.map(t => resolveRoute(t, routes)).filter((f): f is string => !!f))];
}

describe('worker MCP actions under a per-task token', () => {
  const src = readFileSync(join(REPO, 'packages/core/mcp-tools.ts'), 'utf8');
  const routes = trackedRoutes();
  const opted = optedIn();

  it('each reaches only opted-in routes, or is refused with a reason', () => {
    const gaps: Record<string, string[]> = {};
    for (const action of workerActions as readonly string[]) {
      if (REFUSED_ACTIONS[action]) continue;
      const refused = REFUSED_CALLS[action] ?? {};
      const missing = callsOf(action, src, routes).filter(f => !opted.has(f) && !refused[f]);
      if (missing.length > 0) gaps[action] = missing;
    }
    expect(gaps).toEqual({});
  });

  it('has no stale reasons', () => {
    const stale: string[] = [];
    for (const action of Object.keys(REFUSED_ACTIONS)) {
      if (!(workerActions as readonly string[]).includes(action)) stale.push(`${action}: not a worker action`);
      else if (callsOf(action, src, routes).every(f => opted.has(f))) stale.push(`${action}: every route it calls is opted in now`);
    }
    for (const [action, calls] of Object.entries(REFUSED_CALLS)) {
      const actual = callsOf(action, src, routes);
      for (const file of Object.keys(calls)) {
        if (!actual.includes(file)) stale.push(`${action} → ${file}: no longer called`);
        else if (opted.has(file)) stale.push(`${action} → ${file}: opted in now`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('resolves the path shapes mcp-tools uses', () => {
    const r = [
      'apps/web/src/app/api/connectors/[id]/route.ts',
      'apps/web/src/app/api/connectors/mounted/route.ts',
      'apps/web/src/app/api/github/pr/route.ts',
      'apps/web/src/app/api/tasks/[id]/notes/route.ts',
    ];
    expect(resolveRoute('/api/connectors/mounted?workspaceId=${x}', r)).toBe(r[1]);
    expect(resolveRoute('/api/connectors/${id}', r)).toBe(r[0]);
    expect(resolveRoute('/api/github/pr${parts.length ? `?${q}` : ""}', r)).toBe(r[2]);
    expect(resolveRoute('/api/tasks/${params.taskId}/notes', r)).toBe(r[3]);
    expect(resolveRoute('/api/nowhere', r)).toBeNull();
  });

  it('can fail: an action calling a route nobody opted in is a gap', () => {
    expect(resolveRoute('/api/tasks/${id}/notes', ['apps/web/src/app/api/tasks/[id]/notes/route.ts'])).not.toBeNull();
    expect(opted.has('apps/web/src/app/api/health/budget/route.ts')).toBe(false);
  });
});
