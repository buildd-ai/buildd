/**
 * The `buildd` tool's `manage_specs` action, kept out of mcp-tools.ts's switch:
 * create, read, revise, list and relate Living Specs over the REST routes
 * (POST|GET /api/specs, GET|PATCH /api/specs/[id], PUT /api/specs/[id]/parent),
 * so the routes' own reach checks apply. submit and approve (POST
 * /api/specs/[id]/submit|approve) are a person's act (G2, decision D-4): the
 * route refuses an agent run or API key with a 403, which this passes through
 * as is. No other sub-action takes a status.
 */
import type { ApiFn, ToolResult } from './mcp-tools';

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export const SPEC_OPS = ['create_draft', 'get', 'revise', 'list', 'relate', 'submit', 'approve'] as const;
export type SpecOp = (typeof SPEC_OPS)[number];

/** A body longer than this is not inlined by `get`: read it in parts with get_artifact. */
export const SPEC_INLINE_BODY_MAX = 20_000;

/** The JSON body of an "API error: NNN - {...}" thrown by `api`, or null. */
function apiError(err: unknown): { status: number; body: Record<string, unknown> | null } | null {
  const m = /^API error: (\d+) - ([\s\S]*)$/.exec(err instanceof Error ? err.message : '');
  if (!m) return null;
  try {
    const body = JSON.parse(m[2]);
    return { status: Number(m[1]), body: body && typeof body === 'object' ? body : null };
  } catch {
    return { status: Number(m[1]), body: null };
  }
}

const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
};

type SpecRow = { id: string; title: string; scope: string; status: string; version: number; headRevision: number; approvedRevision?: number | null; parentSpecId?: string | null; bodyArtifactId: string; updatedAt?: string };

const line = (s: SpecRow) =>
  `- ${s.title} (${s.scope}, ${s.status}) · version ${s.version}, revision ${s.headRevision}${s.approvedRevision ? `, approved revision ${s.approvedRevision}` : ''}${s.parentSpecId ? ` · parent ${s.parentSpecId}` : ''}\n  id: ${s.id}`;

export async function handleSpecsAction(api: ApiFn, params: Record<string, any>, workspaceId: string | null): Promise<ToolResult> {
  const op = params.action as SpecOp;
  if (!op || !(SPEC_OPS as readonly string[]).includes(op)) throw new Error(`action must be one of: ${SPEC_OPS.join(', ')}`);

  switch (op) {
    case 'list': {
      if (!workspaceId) throw new Error('workspaceId is required (no workspace in this session)');
      const { specs } = await api(`/api/specs?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!specs?.length) return text('No Living Specs in this workspace yet. Start one with manage_specs action=create_draft.');
      return text(`${specs.length} spec(s):\n${(specs as SpecRow[]).map(line).join('\n')}`);
    }

    case 'create_draft': {
      if (!workspaceId) throw new Error('workspaceId is required (no workspace in this session)');
      const payload: Record<string, unknown> = { workspaceId, title: need(params.title, 'title'), body: need(params.body, 'body (the spec text, Markdown)') };
      for (const k of ['scope', 'parentSpecId', 'changeSummary'] as const) if (params[k] !== undefined) payload[k] = params[k];
      const { spec } = await api('/api/specs', { method: 'POST', body: JSON.stringify(payload) });
      return text(`Spec draft created: "${spec.title}"\nID: ${spec.id}\nVersion: ${spec.version} (pass it as expectedVersion to revise)\nStatus: ${spec.status}. A person approves it (submit / approve from their own session).`);
    }

    case 'get': {
      const specId = need(params.specId, 'specId');
      const rev = params.revision !== undefined ? `?revision=${encodeURIComponent(String(params.revision))}` : '';
      const view = await api(`/api/specs/${encodeURIComponent(specId)}${rev}`);
      const s = view.spec as SpecRow;
      const body: string = view.body ?? '';
      const reqs = (view.requirements ?? []).map((r: { id: string }) => r.id);
      const history = (view.revisions ?? []).map((r: { revision: number; authorKind: string; changeSummary?: string | null; approvedAt?: string | null }) =>
        `  r${r.revision} by ${r.authorKind}${r.approvedAt ? ' (approved)' : ''}${r.changeSummary ? `: ${r.changeSummary}` : ''}`).join('\n');
      const shown = body.length <= SPEC_INLINE_BODY_MAX
        ? body
        : `(${body.length} characters, not inlined. Read it in parts: get_artifact { artifactId: "${s.bodyArtifactId}", revision: ${view.revision.artifactRevision}, view: "outline" }, then view "section" or "grep".)`;
      return text([
        line(s).slice(2),
        `Showing revision ${view.revision.revision} (sha256 ${view.revision.contentHash}). Revise with expectedVersion ${s.version}.`,
        reqs.length ? `Requirement ids: ${reqs.join(', ')}` : 'Requirement ids: none',
        `Revisions:\n${history}`,
        '',
        shown,
      ].join('\n'));
    }

    case 'revise': {
      const specId = need(params.specId, 'specId');
      if (!Number.isInteger(params.expectedVersion)) throw new Error('expectedVersion (the version you read with get) is required');
      const payload: Record<string, unknown> = { expectedVersion: params.expectedVersion, body: need(params.body, 'body') };
      if (params.changeSummary !== undefined) payload.changeSummary = params.changeSummary;
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        if (r.unchanged) return text(`Unchanged: the body matches revision ${r.revision.revision}, so no new revision was written. Version is still ${r.spec.version}.`);
        return text(`Revised: revision ${r.revision.revision}, version ${r.spec.version} (pass it as expectedVersion next time).`);
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 409 && typeof e.body?.currentVersion === 'number') {
          return errorResult(`Version conflict: the spec is now at version ${e.body.currentVersion}, not ${params.expectedVersion}; nothing was written. Re-read it (manage_specs action=get), merge your change into that text, then revise with expectedVersion ${e.body.currentVersion}.\ncurrentVersion: ${e.body.currentVersion}`);
        }
        throw err;
      }
    }

    case 'submit':
    case 'approve': {
      const specId = need(params.specId, 'specId');
      if (!Number.isInteger(params.expectedVersion)) throw new Error('expectedVersion (the version you read with get) is required');
      if (op === 'approve' && !Number.isInteger(params.revision)) throw new Error('revision (the head revision you read and are approving) is required');
      const payload = op === 'approve' ? { revision: params.revision, expectedVersion: params.expectedVersion } : { expectedVersion: params.expectedVersion };
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}/${op}`, { method: 'POST', body: JSON.stringify(payload) });
        return text(op === 'approve'
          ? `Approved: revision ${r.revision.revision} of "${r.spec.title}" is now in force (sha256 ${r.revision.contentHash}). Version ${r.spec.version}.`
          : `Submitted: "${r.spec.title}" revision ${r.spec.headRevision} is in review. Version ${r.spec.version}.`);
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 403) return errorResult(String(e.body?.error ?? 'Only a person decides on a spec.'));
        if (e?.status === 409) return errorResult(`${String(e.body?.error ?? 'Conflict.')}${typeof e.body?.currentVersion === 'number' ? `\ncurrentVersion: ${e.body.currentVersion}` : ''}`);
        throw err;
      }
    }

    case 'relate': {
      const specId = need(params.specId, 'specId');
      if (!('parentSpecId' in params)) throw new Error('parentSpecId is required (a spec id, or null to clear the parent)');
      try {
        const { spec } = await api(`/api/specs/${encodeURIComponent(specId)}/parent`, { method: 'PUT', body: JSON.stringify({ parentSpecId: params.parentSpecId }) });
        return text(spec.parentSpecId ? `Parent set: ${spec.title} now sits under ${spec.parentSpecId}.` : `Parent cleared: ${spec.title} is a top-level spec.`);
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 409) return errorResult(String(e.body?.error ?? 'That parent would form a cycle.'));
        throw err;
      }
    }
  }
}
