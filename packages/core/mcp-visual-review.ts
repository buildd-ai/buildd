/**
 * The `buildd` tool's visual-QA reads, kept out of mcp-tools.ts's switch:
 * `get_visual_review` (a mission's review, or a workspace's missions with
 * screens awaiting a human) and the `list_runners` text (slots and browser
 * capability). Both go through the caller's `api`, so the routes' own access
 * checks apply: GET /api/missions/[id]/visual-review,
 * GET /api/missions/[id]/artifacts (manual visual evidence, one list read),
 * GET /api/workspaces/[id]/visual-review and GET /api/workers/active.
 */
import type { ApiFn, ToolResult } from './mcp-tools';
import { formatVisualReview, missionArtifacts } from './visual-review-text';
import type { VisualReviewModel } from '@buildd/shared';

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves a workspace param (id, name or repo) to an id, or null when the caller cannot see it. */
export type WorkspaceResolver = (param: unknown) => Promise<string | null>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const notVisible = (raw: string) => errorResult(`Workspace "${raw}" not found or not visible to this token. manage_workspaces action=list shows the ones you can use.`);

/** Most title matches the lookup reads; the API ranks an exact title first. */
const TITLE_LOOKUP_LIMIT = 10;

type MissionRow = { id: string; title?: string; status?: string };

/**
 * A mission id from a title, case-insensitively: an exact title wins, else a
 * unique partial match. The API filters by title (`q`, every status, exact
 * title first), so a mission is found however old it is. Ambiguity and misses
 * are errors that name what was searched, never a guess.
 */
async function missionIdFromTitle(api: ApiFn, title: string, ws: { id: string; raw: string } | null): Promise<{ id: string } | { error: ToolResult }> {
  const wsId = ws?.id ?? null;
  const qs = new URLSearchParams({ q: title, sort: 'recent', limit: String(TITLE_LOOKUP_LIMIT) });
  if (wsId) qs.set('workspaceId', wsId);
  const data = await api(`/api/missions?${qs}`);
  const rows = ((data?.missions ?? []) as MissionRow[]).filter(m => typeof m.title === 'string');
  const want = title.toLowerCase();
  const exact = rows.filter(m => m.title!.toLowerCase() === want);
  const hits = exact.length > 0 ? exact : rows.filter(m => m.title!.toLowerCase().includes(want));
  if (hits.length === 1) return { id: hits[0].id };
  const where = ws ? ` in workspace "${ws.raw}"` : '';
  if (hits.length === 0) {
    const widen = ws ? ' Or omit workspaceId to search every workspace.' : '';
    return { error: errorResult(`No mission title contains "${title}"${where} (every status searched). Check it with manage_missions action=list query="<words>".${widen}`) };
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
  /** The workspace pinned in the MCP URL, if any. Never the token's guessed workspace. */
  pinnedWorkspace: string | null = null,
): Promise<ToolResult> {
  // Only a workspace the caller named narrows the title lookup; with none it
  // is team-wide. The no-mission listing also takes the URL-pinned one. The
  // resolver is never called without a param, so its guess never applies.
  const rawWs = str(params.workspaceId);
  let explicitWs: string | null = null;
  if (rawWs) {
    // The resolver throws for a name this key cannot see, listing the ones it can.
    try { explicitWs = await resolveWorkspace(rawWs); } catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
    if (!explicitWs) return notVisible(rawWs);
  }

  let missionId = str(params.missionId);
  // A title passed as missionId is looked up, as manage_missions does.
  const missionTitle = str(params.missionTitle) || (missionId && !UUID_RE.test(missionId) ? missionId : '');
  if (missionTitle && missionId && !UUID_RE.test(missionId)) missionId = '';
  if (!missionId && missionTitle) {
    const found = await missionIdFromTitle(api, missionTitle, explicitWs ? { id: explicitWs, raw: rawWs } : null);
    if ('error' in found) return found.error;
    missionId = found.id;
  }

  if (missionId) {
    if (!UUID_RE.test(missionId)) return errorResult(`missionId must be a full UUID; pass missionTitle to look a mission up by title.`);
    const id = encodeURIComponent(missionId);
    type MissionHead = { title?: unknown; status?: unknown; completedAt?: unknown };
    const mission = await api(`/api/missions/${id}`) as (MissionHead & { mission?: MissionHead }) | null;
    const m = mission?.mission ?? mission;
    const out = await api(`/api/missions/${id}/visual-review`) as { model?: VisualReviewModel } | null;
    if (!out?.model) return errorResult('The visual review could not be read.');
    const artifacts = await missionArtifacts(api, id);
    return text(formatVisualReview(out.model, typeof m?.title === 'string' ? m.title : null, {
      audience: 'mcp',
      baseUrl: appBaseUrl,
      missionId,
      missionStatus: typeof m?.status === 'string' ? m.status : null,
      missionCompletedAt: typeof m?.completedAt === 'string' ? m.completedAt : null,
      awaitingOnly: params.awaitingOnly === true,
      artifacts,
    }));
  }

  const wsId = explicitWs ?? (pinnedWorkspace ? await resolveWorkspace(pinnedWorkspace) : null);
  if (!wsId) return errorResult('Name a mission (missionTitle or missionId), or pass workspaceId to list screens awaiting review there.');
  const data = await api(`/api/workspaces/${encodeURIComponent(wsId)}/visual-review`) as {
    workspace?: { name?: string };
    missions?: Array<{ id: string; title: string; status: string; phase: string; reason?: string; awaitingHuman: number }>;
    more?: boolean;
  };
  const name = data?.workspace?.name ?? wsId;
  const rows = data?.missions ?? [];
  const more = data?.more ? '\nLeft out: older missions were not checked (only the most recent candidates are); pass missionTitle to read one.' : '';
  if (rows.length === 0) return text(`Nothing waits on you in ${name}: no screens awaiting review, no open visual-audit decision or question.${more}`);
  const total = rows.reduce((n, m) => n + m.awaitingHuman, 0);
  const lines = rows.map(m => `- "${m.title}" (mission ${m.id}, ${m.status}): ${waitsOn(m)}`);
  return text(`${rows.length} mission${rows.length === 1 ? '' : 's'} wait${rows.length === 1 ? 's' : ''} on you in ${name} (${total} screen${total === 1 ? '' : 's'} to review):\n${lines.join('\n')}\nget_visual_review with missionId for the screens and links.${more}`);
}

function waitsOn(m: { reason?: string; awaitingHuman: number }): string {
  if (m.awaitingHuman > 0) return `${m.awaitingHuman} screen${m.awaitingHuman === 1 ? ' needs' : 's need'} your review`;
  if (m.reason === 'question') return 'needs your answer (the audit asked a question)';
  return 'needs your decision (round cap: fix or waive)';
}

type RunnerRow = Record<string, unknown> & {
  environment?: { envKeys?: unknown } | null;
  workspaceIds?: unknown;
  workspaceNames?: unknown;
};

/** The heartbeat advertises the `browser` capability (CAPABILITY_BROWSER). */
function hasBrowser(r: RunnerRow): boolean {
  if (typeof r.browser === 'boolean') return r.browser;
  const keys = r.environment?.envKeys;
  return Array.isArray(keys) && keys.includes('browser');
}

/**
 * `yes` only when the server's `browserOnline` (browserRunnerOnline's rule:
 * fresh heartbeat, capability, claim reach) says so, so a row never
 * contradicts the summary line. A capable runner that is not online says why.
 */
function browserWord(r: RunnerRow, windowMs: number, wsName: string | null): string {
  if (!hasBrowser(r)) return 'no';
  if (r.browserOnline === true) return 'yes';
  if (typeof r.browserOnline !== 'boolean') return 'capable (online not reported)';
  const age = Date.now() - Date.parse(String(r.lastUpdated));
  if (!Number.isNaN(age) && age >= windowMs) {
    return `capable, not online (heartbeat ${Math.round(age / 60_000)}m ago; online = heartbeat within ${Math.round(windowMs / 60_000)}m)`;
  }
  if (r.canClaimInWorkspace === false) return `capable, cannot claim in ${wsName ?? 'this workspace'}`;
  return 'capable, not online';
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
    try { wsId = await resolveWorkspace(rawWs); } catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
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

  const windowMs = typeof data?.onlineWindowMs === 'number' ? data.onlineWindowMs : 3 * 60_000;
  const wsName = wsId ? (data?.workspace?.name ?? rawWs) : null;
  const lines = runners.map((r) => {
    const header = `${r.accountName ?? 'Unknown'} — ${r.localUiUrl} — ${r.activeWorkers ?? '?'} busy of ${r.maxConcurrent ?? '?'} slots — browser: ${browserWord(r, windowMs, wsName)} — branch ${r.trackedBranch ?? 'unknown'}`;
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
