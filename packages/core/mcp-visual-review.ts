/**
 * The `buildd` tool's visual-QA reads, kept out of mcp-tools.ts's switch:
 * `get_visual_review` (a mission's review, or a workspace's missions with
 * screens awaiting a human) and the `list_runners` text (slots and browser
 * capability). Both go through the caller's `api`, so the routes' own access
 * checks apply: GET /api/missions/[id]/visual-review,
 * GET /api/workspaces/[id]/visual-review and GET /api/workers/active.
 */
import type { ApiFn, ToolResult } from './mcp-tools';
import { formatVisualReview } from './visual-review-text';
import type { VisualReviewModel } from '@buildd/shared';

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves a workspace param (id, name or repo) to an id, or null when the caller cannot see it. */
export type WorkspaceResolver = (param: unknown) => Promise<string | null>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const notVisible = (raw: string) => errorResult(`Workspace "${raw}" not found or not visible to this token. manage_workspaces action=list shows the ones you can use.`);

/** Most missions the title lookup reads (the API's cap). */
const TITLE_LOOKUP_LIMIT = 100;

type MissionRow = { id: string; title?: string; status?: string };

/**
 * A mission id from a title, case-insensitively: an exact title wins, else a
 * unique partial match. Ambiguity and misses are errors that name what was
 * searched, never a guess.
 *
 * TODO: switch to the shared mission title resolver once it lands in
 * mcp-tools.ts; this reads the newest TITLE_LOOKUP_LIMIT missions only.
 */
async function missionIdFromTitle(api: ApiFn, title: string, wsId: string | null): Promise<{ id: string } | { error: ToolResult }> {
  const qs = new URLSearchParams({ limit: String(TITLE_LOOKUP_LIMIT) });
  if (wsId) qs.set('workspaceId', wsId);
  const data = await api(`/api/missions?${qs}`);
  const rows = ((data?.missions ?? []) as MissionRow[]).filter(m => typeof m.title === 'string');
  const want = title.toLowerCase();
  const exact = rows.filter(m => m.title!.toLowerCase() === want);
  const hits = exact.length > 0 ? exact : rows.filter(m => m.title!.toLowerCase().includes(want));
  if (hits.length === 1) return { id: hits[0].id };
  const where = wsId ? ' in that workspace' : '';
  if (hits.length === 0) {
    return { error: errorResult(`No mission titled "${title}" among the ${rows.length} missions${where} this token can see (every status). Pass missionId, or check the title with manage_missions action=list status="all".`) };
  }
  const shown = hits.slice(0, 5).map(m => `- "${m.title}" (${m.id}, ${m.status ?? 'unknown'})`);
  const left = hits.length - shown.length;
  return { error: errorResult(`${hits.length} missions match "${title}"${where}; pass missionId:\n${shown.join('\n')}${left > 0 ? `\n${left} more not shown; use a longer title.` : ''}`) };
}

export async function runGetVisualReview(
  api: ApiFn,
  params: Record<string, unknown>,
  resolveWorkspace: WorkspaceResolver,
  appBaseUrl: string,
): Promise<ToolResult> {
  const rawWs = str(params.workspaceId);
  const wsId = await resolveWorkspace(rawWs || undefined);
  if (rawWs && !wsId) return notVisible(rawWs);

  let missionId = str(params.missionId);
  const missionTitle = str(params.missionTitle);
  if (!missionId && missionTitle) {
    const found = await missionIdFromTitle(api, missionTitle, wsId);
    if ('error' in found) return found.error;
    missionId = found.id;
  }

  if (missionId) {
    if (!UUID_RE.test(missionId)) return errorResult(`missionId must be a full UUID; pass missionTitle to look a mission up by title.`);
    const id = encodeURIComponent(missionId);
    const mission = await api(`/api/missions/${id}`) as { title?: unknown; status?: unknown; mission?: { title?: unknown; status?: unknown } } | null;
    const m = mission?.mission ?? mission;
    const out = await api(`/api/missions/${id}/visual-review`) as { model?: VisualReviewModel } | null;
    if (!out?.model) return errorResult('The visual review could not be read.');
    return text(formatVisualReview(out.model, typeof m?.title === 'string' ? m.title : null, {
      audience: 'mcp',
      baseUrl: appBaseUrl,
      missionId,
      missionStatus: typeof m?.status === 'string' ? m.status : null,
      awaitingOnly: params.awaitingOnly === true,
    }));
  }

  if (!wsId) return errorResult('Name a mission (missionTitle or missionId), or a workspace (workspaceId) to list screens awaiting review.');
  const data = await api(`/api/workspaces/${encodeURIComponent(wsId)}/visual-review`) as {
    workspace?: { name?: string };
    missions?: Array<{ id: string; title: string; status: string; phase: string; awaitingHuman: number }>;
    more?: boolean;
  };
  const name = data?.workspace?.name ?? wsId;
  const rows = data?.missions ?? [];
  const more = data?.more ? '\nLeft out: more missions were not checked (only the most recent with unsure screens are); pass missionTitle to read one.' : '';
  if (rows.length === 0) return text(`No screens awaiting review in ${name}.${more}`);
  const total = rows.reduce((n, m) => n + m.awaitingHuman, 0);
  const lines = rows.map(m => `- "${m.title}" (mission ${m.id}, ${m.status}): ${m.awaitingHuman} need your review`);
  return text(`${total} screens awaiting review in ${name}, across ${rows.length} mission(s):\n${lines.join('\n')}\nget_visual_review with missionId for the screens and links.${more}`);
}

type RunnerRow = Record<string, unknown> & {
  environment?: { envKeys?: unknown } | null;
  workspaceIds?: unknown;
  workspaceNames?: unknown;
};

/** The heartbeat advertises the `browser` capability (CAPABILITY_BROWSER), browserRunnerOnline's rule. */
function hasBrowser(r: RunnerRow): boolean {
  if (typeof r.browser === 'boolean') return r.browser;
  const keys = r.environment?.envKeys;
  return Array.isArray(keys) && keys.includes('browser');
}

export async function runListRunners(
  api: ApiFn,
  params: Record<string, unknown>,
  resolveWorkspace: WorkspaceResolver,
): Promise<ToolResult> {
  // Scoping is GET /api/workers/active's: whatever the caller's access
  // resolves to. workspaceId only narrows the list and asks the server for
  // that workspace's browser answer (browserRunnerOnline, the claim rule).
  const rawWs = str(params.workspaceId);
  let wsId: string | null = null;
  if (rawWs) {
    wsId = await resolveWorkspace(rawWs);
    if (!wsId) return notVisible(rawWs);
  }
  const data = await api(wsId ? `/api/workers/active?workspaceId=${encodeURIComponent(wsId)}` : '/api/workers/active');
  const all = (data?.activeLocalUis ?? []) as RunnerRow[];
  const runners = wsId ? all.filter(r => Array.isArray(r.workspaceIds) && (r.workspaceIds as string[]).includes(wsId!)) : all;

  const head: string[] = [];
  if (wsId) {
    const online = data?.browserRunnerOnline;
    head.push(`Browser-capable runner online for ${data?.workspace?.name ?? rawWs}: ${online === true ? 'yes' : online === false ? 'no' : 'unknown'}`);
  }
  const left = all.length - runners.length;
  const tail = left > 0 ? `\n${left} runner${left === 1 ? '' : 's'} of other workspaces not shown; omit workspaceId for all.` : '';
  if (runners.length === 0) return text([...head, 'No active runners visible to this token.'].join('\n') + tail);

  const lines = runners.map((r) => {
    const header = `${r.accountName ?? 'Unknown'} — ${r.localUiUrl} — ${r.activeWorkers ?? '?'} busy of ${r.maxConcurrent ?? '?'} slots — browser: ${hasBrowser(r) ? 'yes' : 'no'} — branch ${r.trackedBranch ?? 'unknown'}`;
    const update = [
      `currentCommit=${r.currentCommit ?? 'null'}`,
      `diskCommit=${r.diskCommit ?? 'null'}`,
      `commitDrift=${r.commitDrift ?? 'null'}`,
      `updating=${r.updating ?? 'null'}`,
      `updateAvailable=${r.updateAvailable ?? 'null'}`,
    ];
    if (r.updateAvailable) update.push(`updateAvailableSince=${r.updateAvailableSince ?? 'unknown'}`);
    if (r.trackedBranch === 'main') update.push(`upToDateWithDeployed=${r.upToDateWithDeployed ?? 'null'}`);
    const runnerBuild = `runnerCommit=${r.runnerCommit ?? 'null'} runnerVersion=${r.runnerVersion ?? 'null'}`;
    const workspaces = ((r.workspaceNames as string[]) ?? []).join(', ') || 'none';
    return `- ${header}\n  ${runnerBuild}\n  ${update.join(' ')}\n  workspaces: ${workspaces} · last heartbeat ${r.lastUpdated}`;
  });

  return text([...head, `${runners.length} runner(s):`, '', lines.join('\n\n')].join('\n') + tail);
}
