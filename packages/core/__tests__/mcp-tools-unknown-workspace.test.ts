/**
 * An explicit workspaceId that does not resolve must fail loudly, naming the
 * value and the workspaces the caller can see. It must never be dropped (a
 * list silently widening to every workspace) or swapped for the connection's
 * default workspace — both answer about the wrong workspace, confidently.
 *
 * Table-driven over every action whose param docs advertise workspaceId; the
 * completeness check at the bottom fails when a new one is added untested.
 */
import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, allActions, type ApiFn, type ActionContext } from '../mcp-tools';

const CONTEXT_WS = '00000000-0000-0000-0000-00000000000c';
const VISIBLE_WS = '00000000-0000-0000-0000-00000000000a';
const UNKNOWN = 'not-a-visible-ws';

/** Minimal params that get each action as far as workspace resolution. */
const CASES: Array<[action: string, params: Record<string, unknown>]> = [
  ['list_tasks', {}],
  ['get_visual_review', {}],
  ['list_runners', {}],
  ['claim_task', {}],
  ['create_task', { title: 'T', description: 'D' }],
  ['create_schedule', { name: 'n', cronExpression: '0 * * * *', title: 't' }],
  ['update_schedule', { scheduleId: 's-1' }],
  ['delete_schedule', { scheduleId: 's-1' }],
  ['list_schedules', {}],
  ['trace_schedule', { minutesAgo: 30 }],
  ['pause_schedules', {}],
  ['register_skill', { name: 'n', content: 'c' }],
  ['list_skills', {}],
  ['get_skill', { slug: 's' }],
  ['update_skill', { slug: 's' }],
  ['delete_skill', { slug: 's' }],
  ['list_artifacts', {}],
  ['explain', {}],
  ['get_error_traces', {}],
  ['read_evidence', { prNumber: 7 }],
  ['read_evidence', { evidenceId: '00000000-0000-0000-0000-0000000000e1' }],
  ['get_budget_forecast', {}],
  ['get_usage_stats', {}],
  ['get_manifest_coverage', {}],
  ['get_path_claim_stats', {}],
  ['get_decision_stats', {}],
  ['get_failure_analytics', {}],
  ['list_incidents', {}],
  ['dispatch_health', {}],
  ['list_connectors', {}],
  ['resolve_capability', { capability: 'observability:query' }],
  ['resolve_capability', {}],
  ['list_releases', {}],
  ['list_prs', {}],
  ['list_discrepancies', {}],
  ['manage_experiments', { action: 'list' }],
  ['manage_providers', { action: 'list' }],
  ['manage_providers', { action: 'explain', surface: 'chat' }],
  ['manage_model_tiers', { action: 'list' }],
  ['manage_evidence_backends', { action: 'list' }],
  ['manage_evidence_backends', { action: 'create', provider: 's3', bucket: 'b' }],
  ['manage_missions', { action: 'list' }],
  ['manage_missions', { action: 'create', title: 'T' }],
  ['manage_missions', { action: 'update', missionId: 'm-1' }],
  ['manage_initiatives', { action: 'list' }],
  ['manage_initiatives', { action: 'create', title: 'T' }],
  ['manage_initiatives', { action: 'update', initiativeId: 'i-1' }],
  ['manage_workspaces', { action: 'get' }],
  ['manage_workspaces', { action: 'update', name: 'x' }],
  ['manage_workspaces', { action: 'create_repo', name: 'x' }],
  ['manage_workspaces', { action: 'init' }],
  ['manage_watched_projects', { action: 'list' }],
  ['manage_watched_projects', { action: 'create', repo: 'o/r' }],
  // A repo alongside does not excuse a bad workspaceId.
  ['trigger_release', { repo: 'o/r' }],
  ['release_status', { repo: 'o/r' }],
];

/**
 * Advertise workspaceId but pass it through for the server to resolve, which
 * answers 404 on a miss (PR routes), or only mention it in prose.
 */
const EXEMPT: Record<string, string> = {
  merge_pr: 'server-resolved (404s)',
  close_pr: 'server-resolved (404s)',
  get_pr: 'server-resolved',
  request_pr_review: 'server-resolved (404s)',
  get_pr_review: 'server-resolved (404s)',
  record_pr_supersession: 'server-resolved',
  spec_compare: 'no workspaceId param (prose mention)',
  query_knowledge: 'no workspaceId param (prose mention)',
};

function makeApi() {
  const calls: string[] = [];
  const api = (async (endpoint: string) => {
    calls.push(endpoint);
    if (endpoint === '/api/workspaces') {
      return { workspaces: [{ id: VISIBLE_WS, name: 'visible-one', repo: 'org/visible-one' }, { id: 'w2', name: 'other-two' }] };
    }
    if (endpoint.startsWith('/api/workspaces/by-repo')) throw new Error('API error: 404 - {"error":"Workspace not found"}');
    if (endpoint.startsWith('/api/capabilities') || endpoint.includes('capabilities')) return { capabilities: {} };
    return {};
  }) as unknown as ApiFn;
  return { api, calls };
}

const ctx: ActionContext = {
  authType: 'api',
  workspaceId: CONTEXT_WS,
  getWorkspaceId: async () => CONTEXT_WS,
  getLevel: async () => 'admin',
};

async function outcome(action: string, params: Record<string, unknown>) {
  const { api, calls } = makeApi();
  try {
    const r: any = await handleBuilddAction(api, action, { ...params, workspaceId: UNKNOWN }, ctx);
    return { text: r?.isError ? String(r.content?.[0]?.text) : null, calls };
  } catch (e) {
    return { text: (e as Error).message, calls };
  }
}

describe('explicit unknown workspaceId fails loudly', () => {
  for (const [action, params] of CASES) {
    const label = `${action}${params.action ? ` ${params.action}` : ''}`;
    it(label, async () => {
      const { text, calls } = await outcome(action, params);
      expect(text).toContain(`"${UNKNOWN}"`);
      expect(text).toContain('visible-one');
      expect(text).toContain('other-two');
      // Never fell back to the connection's workspace.
      expect(calls.some((c) => c.includes(CONTEXT_WS))).toBe(false);
    });
  }

  it('a known name still resolves (control)', async () => {
    const { api, calls } = makeApi();
    await handleBuilddAction(api, 'manage_missions', { action: 'list', workspaceId: 'visible-one' }, ctx);
    expect(calls.some((c) => c.startsWith('/api/missions?') && c.includes(`workspaceId=${VISIBLE_WS}`))).toBe(true);
  });

  it('every action advertising workspaceId is in the table or exempt', () => {
    // Only the action's own line (the shared footer mentions workspaceId too).
    const own = (a: string) => buildParamsDescription([a]).split('\n').find((l) => l.startsWith(`- ${a}:`)) ?? '';
    const advertised = allActions.filter((a) => /\bworkspaceId\b/.test(own(a)));
    const covered = new Set([...CASES.map(([a]) => a), ...Object.keys(EXEMPT)]);
    expect(advertised.filter((a) => !covered.has(a))).toEqual([]);
  });
});
