/**
 * The `buildd` tool's `manage_specs` action, kept out of mcp-tools.ts's switch:
 * create, read, revise, list and relate Living Specs over the REST routes
 * (POST|GET /api/specs, GET|PATCH /api/specs/[id], PUT /api/specs/[id]/parent),
 * so the routes' own reach checks apply. submit and approve (POST
 * /api/specs/[id]/submit|approve) are a person's act (G2, decision D-4): the
 * route refuses an agent run or API key with a 403, which this passes through
 * as is. From an OAuth session an approve does not approve: the route returns
 * a link the person opens on buildd.dev to confirm it, which this shows. No
 * other sub-action takes a status.
 *
 * outcome, verdict and conflict are Living Specs verification (V1, D-5) over
 * /api/specs/outcomes/[taskId] and /api/specs/[id]/conflicts: a task's governed
 * outcome against its pinned revision, one verdict on one criterion, and an
 * advisory conflict between two criteria. None of them blocks anything.
 *
 * revise with `section` (an outline id) or `heading` replaces just that
 * section; the server rebuilds the whole body and revises it as usual.
 *
 * repoRefs (on create_draft / revise) cite repo specs at an exact commit (D-1);
 * read_ref reads one of them at that commit, bounded, over
 * GET /api/specs/[id]/repo-ref.
 *
 * attach_provisional pins finished tasks to the revision they were built
 * against (POST /api/specs/[id]/provisional), so a later approval grades them:
 * a person's or an admin token's act, never an agent run's.
 *
 * import reads the linked repo's docs/specs/*.md at one commit and, as a dry
 * run by default, says what each file would become (POST /api/specs/import):
 * the spec, its area, its provenance, duplicates and skipped files.
 * confirm_import approves a batch of imported specs in one act
 * (POST /api/specs/import/confirm): a person's act, an agent run gets a 403.
 *
 * diff (read-only) says what changed between two revisions, over
 * GET /api/specs/[id]/diff: sections added, removed and changed, then a capped
 * unified line diff of them.
 */
import type { ApiFn, ToolResult } from './mcp-tools';
import { SUB_ACTIONS } from './mcp-sub-actions';

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** The sub-actions, from the one registry every surface reads (mcp-sub-actions.ts). */
export const SPEC_OPS = SUB_ACTIONS.manage_specs;
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

type DuplicateCheckView =
  | { ran: true; warnings: Array<{ specId: string; title: string; relation: string; p: number }> }
  | { ran: false; reason: string };

/** What the duplicate check found, for the create reply. Empty when it found nothing. */
const duplicateText = (d: DuplicateCheckView | null): string => {
  if (!d) return '';
  if (!d.ran) return `\nDuplicate check did not run: ${d.reason}.`;
  if (!d.warnings.length) return '';
  return `\nOverlaps with approved specs (check the shared criteria; consider a common parent):\n${d.warnings.map((w) => `  ${w.title} (${w.specId}): ${w.relation}, p ${w.p.toFixed(2)}`).join('\n')}`;
};

const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
};

type SpecRow = { id: string; title: string; scope: string; status: string; version: number; headRevision: number; approvedRevision?: number | null; parentSpecId?: string | null; bodyArtifactId: string; updatedAt?: string };

const line = (s: SpecRow) =>
  `- ${s.title} (${s.scope}, ${s.status}) · version ${s.version}, revision ${s.headRevision}${s.approvedRevision ? `, approved revision ${s.approvedRevision}` : ''}${s.parentSpecId ? ` · parent ${s.parentSpecId}` : ''}\n  id: ${s.id}`;

type Outcome = { outcome: string; reason: string; revision: number; currentHeadSha: string | null; criteria: Array<{ criterionId: string; verdict: string | null; headSha: string | null; stale: boolean }> };

/** The governed outcome in words: the verdict first, then one line per criterion. */
export function outcomeText(o: Outcome): string {
  const head = o.currentHeadSha ? o.currentHeadSha.slice(0, 12) : 'no PR head yet';
  const rows = o.criteria.map((c) => `  ${c.criterionId}: ${c.verdict ?? 'no verdict'}${c.verdict && c.stale ? ` (on ${String(c.headSha).slice(0, 12)}, not the current head)` : ''}`);
  return [`Governed outcome: ${o.outcome.toUpperCase()} against spec revision ${o.revision}, head ${head}. ${o.reason}.`, ...rows].join('\n');
}

type OrganizeRow = { specId: string; title: string; p: number | null; answer?: string; newArea?: { title: string } };
type OrganizeReply =
  | { mode: 'taxonomy'; dryRun: true; specs: number; proposal: { product: { title: string }; areas: Array<{ key: string; title: string; charter: string; members: Array<{ specId: string; title: string }> }> } }
  | { mode: 'taxonomy'; dryRun: false; product: { title: string } | null; created: Array<{ key: string; title: string; specId: string; filed: number }>; refused: Array<{ key: string; title: string; reason: string }> }
  | { mode: 'sweep'; dryRun: boolean; scanned: number; remaining: number; skipped: number; classifier: string | null; groups: Array<{ label: string; area: { specId: string } | null; filed: OrganizeRow[]; suggested: OrganizeRow[] }> };

const pText = (p: number | null) => (p === null ? '' : `, p ${p.toFixed(2)}`);

/** An organize run in words: the proposal or the batch, grouped by area. */
export function organizeText(r: OrganizeReply): string {
  if (r.mode === 'taxonomy' && r.dryRun) {
    const areas = r.proposal.areas.map((a) => `- ${a.title} [key ${a.key}] (${a.members.length} spec${a.members.length === 1 ? '' : 's'})\n  ${a.charter}\n${a.members.slice(0, 8).map((m) => `    · ${m.title} (${m.specId})`).join('\n')}${a.members.length > 8 ? `\n    · and ${a.members.length - 8} more` : ''}`);
    return [`Proposed taxonomy for ${r.specs} spec(s) (nothing created): product "${r.proposal.product.title}" and ${r.proposal.areas.length} area(s).`, ...areas,
      'Show it to a person. To create it: organize { dryRun: false }, optionally areas: [keys] for part of it and edits: { [key]: { title, charter } }.'].join('\n');
  }
  if (r.mode === 'taxonomy') {
    return [`Taxonomy created${r.product ? ` under product "${r.product.title}"` : ''}:`, ...r.created.map((c) => `- ${c.title} (${c.specId}): ${c.filed} spec(s) filed`),
      ...r.refused.map((x) => `- not created: ${x.title}: ${x.reason}`)].join('\n');
  }
  const head = `${r.dryRun ? 'Dry run (nothing written)' : 'Organized'}: ${r.scanned} unfiled spec(s) looked at${r.remaining ? `, ${r.remaining} left for the next run` : ''}${r.skipped ? `, ${r.skipped} already placed or reviewed` : ''}.`;
  if (!r.groups.length) return `${head}${r.classifier ? `\nNo area answer: ${r.classifier}.` : ''}\nNothing to file or suggest.`;
  const groups = r.groups.map((g) => [
    `${g.label}${g.area ? ` (${g.area.specId})` : ''}:`,
    ...g.filed.map((x) => `  filed${r.dryRun ? ' (would be)' : ''}: ${x.title} (${x.specId})${pText(x.p)}`),
    ...g.suggested.map((x) => `  suggested: ${x.title} (${x.specId})${pText(x.p)}${x.newArea ? `, a new area like "${x.newArea.title}"` : ''}`),
  ].join('\n'));
  return [head, ...groups, r.classifier ? `Some answers fell back to similarity: ${r.classifier}.` : '', r.dryRun ? 'Run organize { dryRun: false } to apply it; every filing can be undone on the spec page.' : 'Each filing shows "Filed by buildd" with undo on its spec page.'].filter(Boolean).join('\n');
}

/** Sub-actions scoped to a workspace rather than to a spec or task: the caller resolves the session workspace for these. */
export const WORKSPACE_SPEC_OPS = ['create_draft', 'list', 'organize', 'import'] as const;

type ImportRow = { path: string; action: 'create' | 'reimport' | 'skip'; reason?: string; message?: string; specId?: string; revision?: number; spec?: { title: string }; area: { specId: string | null; title: string; proposed: boolean } | null; provenance?: { commitSha: string; prNumber: number | null }; duplicates?: Array<{ specId: string; title: string; relation: string; p: number }> };
type ImportReply = { dryRun?: boolean; repo?: string; commitSha?: string; files?: ImportRow[]; counts?: { create: number; reimport: number; skip: number }; byArea?: Array<{ area: string; areaSpecId: string | null; proposed: boolean; count: number }> };

/** An import run in words: counts, then the files grouped by area, then what was skipped and why. */
export function importText(r: ImportReply): string {
  const files = r.files ?? [];
  const c = r.counts ?? { create: 0, reimport: 0, skip: 0 };
  const at = r.commitSha ? `${r.repo ?? 'the repo'}@${r.commitSha.slice(0, 7)}` : (r.repo ?? 'the repo');
  const head = `${r.dryRun === false ? 'Imported' : 'Dry run (nothing written)'} from ${at}: ${c.create} to create, ${c.reimport} to re-import as a new revision, ${c.skip} skipped.`;
  const groups = (r.byArea ?? []).map((a) => {
    const rows = files.filter((f) => f.action !== 'skip' && (f.area?.title ?? 'Unfiled') === a.area && (f.area?.specId ?? null) === a.areaSpecId);
    return [`${a.area}${a.proposed ? ' (no such area yet; organize will suggest one)' : a.areaSpecId ? ` (${a.areaSpecId})` : ''}: ${a.count}`,
      ...rows.map((f) => `  ${f.action === 'reimport' ? 're-import' : 'create'}: ${f.spec?.title ?? f.path} from ${f.path}${f.provenance?.prNumber ? `, last changed in #${f.provenance.prNumber}` : ''}${f.specId ? ` → ${f.specId}${f.revision ? ` r${f.revision}` : ''}` : ''}${f.duplicates?.length ? `\n    possible duplicate of ${f.duplicates.map((d) => `"${d.title}" (${d.specId}, ${d.relation} p ${d.p.toFixed(2)})`).join(', ')}` : ''}`)].join('\n');
  });
  const skipped = files.filter((f) => f.action === 'skip');
  const skipLines = skipped.length ? [`Skipped:`, ...skipped.map((f) => `  ${f.path}: ${f.reason}${f.message ? `, ${f.message}` : ''}`)] : [];
  const next = r.dryRun === false
    ? 'Imported specs are not approved, and the repo file stays their source until a person confirms them: confirm_import { specIds } from the specs page, by area.'
    : 'Show it to a person. To write it: import { dryRun: false }.';
  return [head, ...groups, ...skipLines, next].join('\n');
}

type ConfirmReply = { confirmed?: Array<{ specId: string; title: string; path: string; commitSha: string }>; skipped?: Array<{ specId: string; path?: string; reason: string; message: string }>; pending?: { confirmUrl: string; specIds: string[] } };

export function confirmImportText(r: ConfirmReply): string {
  if (r.pending) return `Nothing was confirmed: confirming an import is a person's act on buildd.dev. Open ${r.pending.confirmUrl} to confirm ${r.pending.specIds.length} spec(s).`;
  const ok = r.confirmed ?? [];
  const no = r.skipped ?? [];
  return [`Confirmed ${ok.length} import(s)${no.length ? `, ${no.length} not confirmed` : ''}.`,
    ...ok.map((x) => `  confirmed: ${x.title} (${x.specId}) from ${x.path}@${x.commitSha.slice(0, 7)}`),
    ...no.map((x) => `  not confirmed: ${x.path ?? x.specId}: ${x.reason}, ${x.message}`)].join('\n');
}

export async function handleSpecsAction(api: ApiFn, params: Record<string, any>, workspaceId: string | null, appBase = 'https://buildd.dev'): Promise<ToolResult> {
  const specUrl = (id: string) => `${appBase.replace(/\/+$/, '')}/app/specs/${encodeURIComponent(id)}`;
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
      for (const k of ['scope', 'parentSpecId', 'changeSummary', 'repoRefs', 'design', 'supersedes', 'distinctBecause'] as const) if (params[k] !== undefined) payload[k] = params[k];
      let spec;
      let duplicateCheck: DuplicateCheckView | null = null;
      let suggestedParent: { specId: string; title: string; reason: string } | null = null;
      try {
        ({ spec, duplicateCheck, suggestedParent } = await api('/api/specs', { method: 'POST', body: JSON.stringify(payload) }));
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 400 || e?.status === 502 || (e?.status === 409 && e.body?.code === 'spec_duplicate')) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
      return text(`Spec draft created: "${spec.title}"\nID: ${spec.id}\nVersion: ${spec.version} (pass it as expectedVersion to revise)\nStatus: ${spec.status}\nSpec URL: ${specUrl(spec.id)}\nA person approves it (submit / approve from their own session).${duplicateText(duplicateCheck)}${suggestedParent ? `\nSuggested parent: "${suggestedParent.title}" (${suggestedParent.specId}), ${suggestedParent.reason.charAt(0).toLowerCase()}${suggestedParent.reason.slice(1)}. Set it with manage_specs action=relate { specId, parentSpecId }.` : ''}`);
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
        `Spec URL: ${specUrl(s.id)}`,
        `Showing revision ${view.revision.revision} (sha256 ${view.revision.contentHash}). Revise with expectedVersion ${s.version}.`,
        reqs.length ? `Requirement ids: ${reqs.join(', ')}` : 'Requirement ids: none',
        `Revisions:\n${history}`,
        ...(view.revision.design
          ? [`Design: ${view.revision.design.kind} ${view.revision.design.ref} at version ${view.revision.design.version}${view.revision.design.screens?.length ? ` (screens: ${view.revision.design.screens.map((x: { id: string }) => x.id).join(', ')})` : ''}${view.revision.design.kind === 'artifact' ? `; read it with get_artifact { artifactId: "${view.revision.design.ref}", revision: ${view.revision.design.version} }` : ''}`]
          : []),
        ...(view.revision.repoRefs?.length
          ? [`Repo specs cited (read one with manage_specs action=read_ref { specId, path }):\n${(view.revision.repoRefs as Array<{ path: string; commitSha: string }>).map((r) => `  ${r.path} @ ${r.commitSha}`).join('\n')}`]
          : []),
        '',
        shown,
      ].join('\n'));
    }

    case 'revise': {
      const specId = need(params.specId, 'specId');
      if (!Number.isInteger(params.expectedVersion)) throw new Error('expectedVersion (the version you read with get) is required');
      // section / heading: body is that one section's text, sent as written.
      const target = params.section !== undefined ? { section: params.section } : params.heading !== undefined ? { heading: params.heading } : null;
      if (target && (typeof params.body !== 'string' || !params.body.trim())) throw new Error('body (the section text, its heading line included) is required');
      const payload: Record<string, unknown> = { expectedVersion: params.expectedVersion, ...target, body: target ? params.body : need(params.body, 'body') };
      if (params.changeSummary !== undefined) payload.changeSummary = params.changeSummary;
      if (params.repoRefs !== undefined) payload.repoRefs = params.repoRefs;
      if (params.design !== undefined) payload.design = params.design;
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        if (r.unchanged) return text(`Unchanged: the body and repo references match revision ${r.revision.revision}, so no new revision was written. Version is still ${r.spec.version}.\nSpec URL: ${specUrl(specId)}`);
        const what = target ? ` (${'section' in target ? `section ${String(target.section)}` : `section "${String(target.heading)}"`} replaced, the rest kept)` : '';
        return text(`Revised${what}: revision ${r.revision.revision}, version ${r.spec.version} (pass it as expectedVersion next time).\nSpec URL: ${specUrl(specId)}`);
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 400 || e?.status === 502) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        if (e?.status === 409 && typeof e.body?.currentVersion === 'number') {
          return errorResult(`Version conflict: the spec is now at version ${e.body.currentVersion}, not ${params.expectedVersion}; nothing was written. Re-read it (manage_specs action=get), merge your change into that text, then revise with expectedVersion ${e.body.currentVersion}.\ncurrentVersion: ${e.body.currentVersion}`);
        }
        // A body changed outside a revise: no version to retry at, so the reason as the server gave it.
        if (e?.status === 409) return errorResult(String(e.body?.error ?? 'Refused (409).'));
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
        if (op === 'approve' && r.pending) {
          return text(`Not approved yet: approving a spec is the person's own decision, so it waits for them to confirm it on buildd.dev.\nConfirm revision ${r.pending.revision} of "${r.spec.title}": ${r.pending.confirmUrl}\nThe link works until ${r.pending.expiresAt}, and only while the spec stays at version ${r.spec.version}.\nSpec URL: ${specUrl(specId)}`);
        }
        return text(op === 'approve'
          ? `Approved: revision ${r.revision.revision} of "${r.spec.title}" is now in force (sha256 ${r.revision.contentHash}). Version ${r.spec.version}.\nSpec URL: ${specUrl(specId)}`
          : `Submitted: "${r.spec.title}" revision ${r.spec.headRevision} is in review. Version ${r.spec.version}.\nSpec URL: ${specUrl(specId)}`);
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 403) return errorResult(String(e.body?.error ?? 'Only a person decides on a spec.'));
        if (e?.status === 409) return errorResult(`${String(e.body?.error ?? 'Conflict.')}${typeof e.body?.currentVersion === 'number' ? `\ncurrentVersion: ${e.body.currentVersion}` : ''}`);
        throw err;
      }
    }

    case 'outcome':
    case 'verdict': {
      const taskId = need(params.taskId, 'taskId');
      const path = `/api/specs/outcomes/${encodeURIComponent(taskId)}`;
      try {
        const r = op === 'outcome'
          ? await api(path)
          : params.checker === 'visual'
          ? await api(path, { method: 'POST', body: JSON.stringify({
            checker: 'visual', criterionId: need(params.criterionId, 'criterionId'), verdict: need(params.verdict, 'verdict'), capturedSha: need(params.capturedSha, 'capturedSha'),
            ...(params.screenshotIds !== undefined ? { screenshotIds: params.screenshotIds } : {}),
            ...(params.designShotIds !== undefined ? { designShotIds: params.designShotIds } : {}),
            ...(params.observed !== undefined ? { observed: params.observed } : {}),
          }) })
          : await api(path, { method: 'POST', body: JSON.stringify({
            criterionId: need(params.criterionId, 'criterionId'), verdict: need(params.verdict, 'verdict'), headSha: need(params.headSha, 'headSha'),
            ...(params.evidenceRefs !== undefined ? { evidenceRefs: params.evidenceRefs } : {}),
            ...(params.readIds !== undefined ? { readIds: params.readIds } : {}),
            ...(params.observed !== undefined ? { observed: params.observed } : {}),
          }) });
        return text(`${op === 'verdict' ? `Recorded ${params.verdict} on ${params.criterionId}.
` : ''}${outcomeText(r.outcome)}`);
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 403, 409].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'conflict': {
      const specId = need(params.specId, 'specId');
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}/conflicts`, { method: 'POST', body: JSON.stringify({ revision: params.revision, criterionIds: params.criterionIds, ...(params.note !== undefined ? { note: params.note } : {}) }) });
        return text(`Conflict recorded as an advisory discrepancy (${r.discrepancyId}). It blocks nothing; a person accepts or resolves it.`);
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 409].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'comment': {
      const specId = need(params.specId, 'specId');
      const anchor = params.criterion !== undefined ? { criterion: params.criterion } : params.heading !== undefined ? { heading: params.heading } : { section: params.section };
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}/comments`, { method: 'POST', body: JSON.stringify({
          anchor, body: need(params.body, 'body (the comment)'),
          ...(params.revision !== undefined ? { revision: params.revision } : {}),
          ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
        }) });
        const c = r.comment;
        return text(`Comment ${c.id} added on ${c.anchor.kind === 'criterion' ? c.anchor.id : `section "${c.anchor.label}"`} of revision ${c.madeOnRevision}. It does not change the spec; a person resolves it.`);
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 404].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'comments': {
      const specId = need(params.specId, 'specId');
      const q = params.revision !== undefined ? `?revision=${encodeURIComponent(String(params.revision))}` : '';
      const r = await api(`/api/specs/${encodeURIComponent(specId)}/comments${q}`);
      const rows = (r.comments ?? []) as Array<{ id: string; anchor: { kind: string; id: string; label: string }; body: string; author: { kind: string }; state: string; madeOnRevision: number; parentCommentId: string | null }>;
      if (!rows.length) return text(`No comments on revision ${r.revision}.`);
      return text(`Comments readable on revision ${r.revision}:\n${rows.map((c) => `  ${c.parentCommentId ? '  ↳ ' : ''}[${c.state}] ${c.anchor.kind === 'criterion' ? c.anchor.id : `"${c.anchor.label}"`} (r${c.madeOnRevision}, ${c.author.kind}, ${c.id}): ${c.body.length > 300 ? `${c.body.slice(0, 300)}…` : c.body}`).join('\n')}`);
    }

    case 'metadata': {
      // The metadata block (living-specs.md §18, R-31): read it, or change
      // fields with a reason. Never a new revision; write access is enough.
      const specId = need(params.specId, 'specId');
      const path = `/api/specs/${encodeURIComponent(specId)}/metadata`;
      if (params.changes === undefined) {
        const r = await api(path);
        const rows = (r.changes ?? []) as Array<{ field: string; previousValue: unknown; newValue: unknown; reason: string; changedByKind: string; createdAt: string }>;
        return text([`Metadata: ${JSON.stringify(r.metadata ?? {})}`, ...rows.slice(0, 20).map((c) => `  ${c.createdAt.slice(0, 10)} ${c.field}: ${JSON.stringify(c.previousValue)} -> ${JSON.stringify(c.newValue)} (${c.changedByKind}: ${c.reason})`)].join('\n'));
      }
      try {
        const r = await api(path, { method: 'PATCH', body: JSON.stringify({ changes: params.changes, reason: params.reason }) });
        return text(r.changed?.length
          ? `Metadata updated (${r.changed.join(', ')}). The version (${r.spec.version}) and the approved revision did not change; a native-sourced spec's repo copy PR is updated.`
          : 'Nothing changed: the metadata already says that.');
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 404, 409].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'read_ref': {
      const specId = need(params.specId, 'specId');
      const q = new URLSearchParams({ path: need(params.path, 'path') });
      for (const k of ['revision', 'view', 'section', 'offset', 'length', 'grep'] as const) if (params[k] !== undefined) q.set(k, String(params[k]));
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}/repo-ref?${q}`);
        const read = r.read ?? {};
        const head = `${r.path} @ ${r.commitSha} (cited by revision ${r.revision}), ${read.chars} characters, view ${read.view}.`;
        if (read.view === 'outline') return text(`${head}\n${(read.sections ?? []).map((x: { id: string; title: string; chars: number }) => `  ${x.id} ${x.title} (${x.chars} chars)`).join('\n')}\nRead a part with view "section" and its id, or "grep".`);
        if (read.view === 'grep') return text(`${head}\n${(read.matches ?? []).map((m: { line: number; text: string }) => `  L${m.line}: ${m.text}`).join('\n') || '  no matches'}${read.truncated ? '\n  (more matches not shown)' : ''}`);
        if (read.view === 'meta') return text(`${head} ${read.sections} section(s).`);
        return text(`${head}${read.truncated ? ' Truncated: read the rest with view "range".' : ''}\n\n${read.text ?? ''}`);
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 404, 502].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'diff': {
      const specId = need(params.specId, 'specId');
      const q = new URLSearchParams();
      for (const k of ['from', 'to'] as const) if (params[k] !== undefined) q.set(k, String(params[k]));
      try {
        const d = await api(`/api/specs/${encodeURIComponent(specId)}/diff${q.size ? `?${q}` : ''}`);
        const side = (x: { revision: number; approved: boolean }) => `revision ${x.revision}${x.approved ? ' (approved)' : ''}`;
        const head = `${side(d.from)} → ${side(d.to)}`;
        if (d.identical) return text(`${head}: no change.`);
        const sections = (d.sections as Array<{ kind: string; path: string; linesAdded: number; linesRemoved: number }>)
          .map((x) => `  ${x.kind} ${x.path} (+${x.linesAdded} −${x.linesRemoved})`).join('\n');
        return text([
          `${head}: ${d.sections.length} section(s) changed.`,
          sections,
          '',
          d.diff,
          ...(d.omittedLines ? [`(${d.omittedLines} more diff line(s) not shown: read a section with get_artifact view "section", or diff a narrower pair of revisions)`] : []),
        ].join('\n'));
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 404, 409].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'attach_provisional': {
      // Building ahead of approval (living-specs.md §20, R-43): a person's or an
      // admin token's act; an agent run gets the route's 403, passed through.
      const specId = need(params.specId, 'specId');
      try {
        const r = await api(`/api/specs/${encodeURIComponent(specId)}/provisional`, { method: 'POST', body: JSON.stringify({ revision: params.revision, taskIds: params.taskIds }) });
        const rows = (r.results ?? []) as Array<{ taskId: string; attached: boolean; reason?: string }>;
        const regraded = (r.regraded ?? []) as Array<{ taskId: string; to: number }>;
        return text([
          `Revision ${r.revision}${r.provisional ? ' (not approved: pinned provisionally, a later approval re-grades the work)' : ' (approved: pinned to it)'}:`,
          ...rows.map((x) => `  ${x.taskId}: ${x.attached ? 'attached' : `not attached, ${x.reason ?? 'refused'}`}`),
          ...(regraded.length ? [`Re-graded at once against approved revision ${regraded[0].to}: ${regraded.length} task(s).`] : []),
        ].join('\n'));
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 403, 404, 409].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'organize': {
      if (!workspaceId) throw new Error('workspaceId is required (no workspace in this session)');
      const payload: Record<string, unknown> = { workspaceId };
      for (const k of ['dryRun', 'limit', 'areas', 'edits'] as const) if (params[k] !== undefined) payload[k] = params[k];
      try {
        return text(organizeText(await api('/api/specs/organize', { method: 'POST', body: JSON.stringify(payload) })));
      } catch (err) {
        const e = apiError(err);
        if (e?.status === 400 || e?.status === 409) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'import': {
      if (!workspaceId) throw new Error('workspaceId is required (no workspace in this session)');
      const payload: Record<string, unknown> = { workspaceId };
      for (const k of ['dryRun', 'ref', 'paths', 'allowDuplicates'] as const) if (params[k] !== undefined) payload[k] = params[k];
      try {
        return text(importText(await api('/api/specs/import', { method: 'POST', body: JSON.stringify(payload) })));
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 404, 502].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
        throw err;
      }
    }

    case 'confirm_import': {
      // A person's act (R-19): an agent run or API key gets the route's 403, passed through.
      if (!Array.isArray(params.specIds) || !params.specIds.length) throw new Error('specIds (the imported specs to confirm) is required');
      const payload: Record<string, unknown> = { specIds: params.specIds };
      // The batch names its workspace; an explicit one must be a UUID (a repo name is not resolved here).
      if (typeof params.workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(params.workspaceId)) payload.workspaceId = params.workspaceId;
      try {
        return text(confirmImportText(await api('/api/specs/import/confirm', { method: 'POST', body: JSON.stringify(payload) })));
      } catch (err) {
        const e = apiError(err);
        if (e && [400, 403, 404].includes(e.status)) return errorResult(String(e.body?.error ?? `Refused (${e.status}).`));
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
