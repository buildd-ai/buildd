import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { artifacts, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { isVerdict, type Verdict } from '@buildd/spec-contract/outcome';
import { isUuid } from '@/lib/uuid';
import { copyObject } from '@/lib/storage';
import { buildArtifactKey } from '@/lib/storage-keys';
import { isAncestor } from '@/lib/integration-refresh';
import { mintedByUploadUrl } from '@/lib/visual-audit-evidence';
import { currentPrHeadSha, recordAuditedVerdict, type OutcomeView } from '@/lib/specs/outcome';
import { linkedRepo } from '@/lib/specs/repo-source';
import { readPinnedSpecRevision } from '@/lib/specs/pin';
import { criterionScreens } from '@buildd/spec-contract/check-lines';
import { MAX_VISUAL_SHOTS, VISUAL_EVIDENCE_RETENTION_DAYS } from '@/lib/specs/visual-limits';

export { MAX_VISUAL_SHOTS, VISUAL_EVIDENCE_RETENTION_DAYS };
import { fail, type SpecCaller, type SpecError } from '@/lib/specs/store';

/**
 * Visual verdicts on spec criteria (docs/specs/living-specs.md §11): the
 * mission's `[surface audit]` grades the criteria of the builder tasks it
 * depends on, with its own screenshots as the evidence.
 *
 * Who: only the audit's own run (its per-task token), and only an audit the
 * platform or a person filed (no agent created it), in the subject's mission,
 * depending on the subject, and neither the subject nor filed under it. A
 * task never grades its own work (D-5).
 *
 * What it judged: the auditor screenshots the mission's capture ref, not the
 * subject's PR head. The verdict binds to that head only when the captured
 * commit contains it; otherwise nothing is recorded.
 *
 * Evidence: a pass or fail cites 1 to MAX_VISUAL_SHOTS screenshots this audit's
 * workers uploaded. Each is copied out of the audit-shot area (which expires
 * after 30 days) into the artifact area, which keeps it at least
 * VISUAL_EVIDENCE_RETENTION_DAYS (D-10). `unsupported` is refused: the auditor
 * records only criteria it looked at, since the newest verdict stands (D-7).
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;
const DAY_MS = 86_400_000;

export interface VisualVerdictInput {
  criterionId: unknown;
  verdict: unknown;
  capturedSha: unknown;
  screenshotIds?: unknown;
  /** Screenshots of the pinned design rendered at the same state, for a criterion that names screens (§12). */
  designShotIds?: unknown;
  observed?: unknown;
}

export interface VisualVerdictDeps {
  prHead: (taskId: string) => Promise<string | null>;
  repo: (workspaceId: string) => Promise<{ fullName: string; installationId: number } | null>;
  contains: (installationId: number, repoFullName: string, ancestor: string, head: string) => Promise<boolean | null>;
  copy: (fromKey: string, toKey: string) => Promise<void>;
  now: () => Date;
}

const defaultDeps: VisualVerdictDeps = {
  prHead: currentPrHeadSha,
  repo: linkedRepo,
  contains: (installationId, repoFullName, ancestor, head) => isAncestor(installationId, repoFullName, ancestor, head),
  copy: copyObject,
  now: () => new Date(),
};

type TaskRow = {
  id: string; title: string; workspaceId: string; missionId: string | null; roleSlug: string | null;
  dependsOn: unknown; parentTaskId: string | null; createdByWorkerId: string | null; context?: unknown;
};

export const MAX_DESIGN_SHOTS = 2;

async function loadTask(id: string): Promise<TaskRow | null> {
  const [t] = await db.select({
    id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId, missionId: tasks.missionId, roleSlug: tasks.roleSlug,
    dependsOn: tasks.dependsOn, parentTaskId: tasks.parentTaskId, createdByWorkerId: tasks.createdByWorkerId, context: tasks.context,
  }).from(tasks).where(eq(tasks.id, id)).limit(1);
  return (t as TaskRow | undefined) ?? null;
}

/** Why `audit` may not grade `subject`, or null when it may. Pure. */
export function auditorRefusal(audit: TaskRow, subject: TaskRow): string | null {
  if (audit.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG || !isSurfaceAuditTask(audit.title)) return 'only a mission\'s [surface audit] records visual verdicts';
  if (audit.createdByWorkerId !== null) return 'this audit was filed by an agent; only an audit the platform or a person filed records visual verdicts';
  if (audit.id === subject.id || audit.parentTaskId === subject.id) return 'a task never grades its own work';
  if (!audit.missionId || audit.missionId !== subject.missionId || audit.workspaceId !== subject.workspaceId) return 'the audit is not in this task\'s mission';
  const deps = Array.isArray(audit.dependsOn) ? audit.dependsOn : [];
  if (!deps.includes(subject.id)) return 'the audit does not review this task (it is not one of its dependencies)';
  return null;
}

const basename = (key: string) => key.split('/').pop() || 'screenshot.png';

/** The screenshots among `ids` that a worker of `audit` uploaded through upload-url; null when any is not. */
async function ownShots(audit: TaskRow, ids: readonly string[]): Promise<Array<{ id: string; storageKey: string }> | null> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: artifacts.id, storageKey: artifacts.storageKey, type: artifacts.type, workspaceId: artifacts.workspaceId })
    .from(artifacts)
    .innerJoin(workers, eq(workers.id, artifacts.workerId))
    .where(and(inArray(artifacts.id, [...ids]), eq(workers.taskId, audit.id)));
  const own = rows.filter((r) => r.type === 'screenshot' && r.workspaceId === audit.workspaceId && r.storageKey && mintedByUploadUrl(r, audit.workspaceId));
  return own.length === ids.length ? own.map((r) => ({ id: r.id, storageKey: r.storageKey as string })) : null;
}

export async function recordVisualVerdict(
  caller: SpecCaller,
  subjectTaskId: unknown,
  input: VisualVerdictInput,
  deps: VisualVerdictDeps = defaultDeps,
): Promise<{ ok: true; verdictId: string; outcome: OutcomeView } | SpecError> {
  const auditId = caller.kind === 'account' ? (caller.account.taskScope as { taskId?: string } | undefined)?.taskId : undefined;
  if (!auditId || !isUuid(auditId)) return fail(403, 'Only a mission\'s visual audit, from its own run, records a visual verdict');
  if (typeof subjectTaskId !== 'string' || !isUuid(subjectTaskId)) return fail(404, 'Task not found');
  const [audit, subject] = await Promise.all([loadTask(auditId), loadTask(subjectTaskId)]);
  if (!subject || !audit) return fail(404, 'Task not found');
  const refusal = auditorRefusal(audit, subject);
  if (refusal) return fail(403, `You may not record this visual verdict: ${refusal}`);

  const { criterionId, verdict, capturedSha } = input;
  if (typeof criterionId !== 'string') return fail(400, 'criterionId is required');
  if (!isVerdict(verdict) || verdict === 'unsupported') {
    return fail(400, 'verdict must be pass, fail or inconclusive: record only the criteria you looked at, and leave the rest to the code reviewer');
  }
  if (typeof capturedSha !== 'string' || !FULL_SHA.test(capturedSha)) return fail(400, 'capturedSha (the full commit the screenshots were taken at) is required');
  const observed = typeof input.observed === 'string' && input.observed.trim() ? input.observed.trim().slice(0, 500) : undefined;

  const ids = input.screenshotIds === undefined ? [] : input.screenshotIds;
  if (!Array.isArray(ids) || ids.length > MAX_VISUAL_SHOTS || !ids.every((id) => typeof id === 'string' && isUuid(id))) {
    return fail(400, `screenshotIds must be at most ${MAX_VISUAL_SHOTS} screenshot artifact ids`);
  }
  const shotIds = [...new Set(ids as string[])];
  if (verdict !== 'inconclusive' && shotIds.length === 0) return fail(400, `A visual ${verdict} cites at least one screenshot this audit took`);
  if (verdict === 'inconclusive' && !observed) return fail(400, 'An inconclusive visual verdict says what could not be seen (observed)');

  const own = await ownShots(audit, shotIds);
  if (!own) return fail(400, 'screenshotIds must name screenshots this audit\'s own run uploaded');

  // A criterion that names design screens is judged against the design too (§12).
  const pin = subject.context && typeof subject.context === 'object' ? (subject.context as Record<string, unknown>).specSource as Record<string, unknown> | undefined : undefined;
  const read = pin ? await readPinnedSpecRevision(pin) : null;
  const screens = read?.ok && read.design ? criterionScreens(read.body).find((c) => c.criterionId === criterionId)?.screens ?? [] : [];
  const rawDesign = input.designShotIds === undefined ? [] : input.designShotIds;
  if (!Array.isArray(rawDesign) || rawDesign.length > MAX_DESIGN_SHOTS || !rawDesign.every((id) => typeof id === 'string' && isUuid(id))) {
    return fail(400, `designShotIds must be at most ${MAX_DESIGN_SHOTS} screenshot artifact ids`);
  }
  const designIds = [...new Set(rawDesign as string[])];
  if (screens.length > 0 && verdict !== 'inconclusive' && designIds.length === 0) {
    return fail(400, `${criterionId} names design screens (${screens.join(', ')}): a visual ${verdict} cites at least one screenshot of the design at the pinned version (designShotIds)`);
  }
  const designShots = await ownShots(audit, designIds);
  if (!designShots) return fail(400, 'designShotIds must name screenshots this audit\'s own run uploaded');
  const shots = own;

  const head = await deps.prHead(subject.id);
  if (!head) return fail(409, 'This task has no PR head to judge, so a visual verdict cannot bind to one');
  const repo = await deps.repo(subject.workspaceId);
  if (!repo) return fail(409, 'This workspace has no linked repo, so the captured commit cannot be checked against the PR head');
  const contains = await deps.contains(repo.installationId, repo.fullName, head, capturedSha);
  if (contains === null) return fail(502, 'GitHub could not be reached to check the captured commit; nothing was recorded, try again');
  if (!contains) return fail(409, `The captured commit ${capturedSha.slice(0, 12)} does not contain this task's PR head ${head.slice(0, 12)}; capture again after it lands. Nothing was recorded`);

  const retained: Array<{ id: string; key: string; design: boolean }> = [];
  try {
    for (const s of [...shots.map((x) => ({ ...x, design: false })), ...designShots.map((x) => ({ ...x, design: true }))]) {
      const key = buildArtifactKey(audit.workspaceId, randomUUID(), basename(s.storageKey));
      await deps.copy(s.storageKey, key);
      retained.push({ id: s.id, key, design: s.design });
    }
  } catch {
    return fail(502, 'The screenshots could not be kept for the verdict; nothing was recorded, try again');
  }

  const refs = [
    ...retained.flatMap((r) => [{ kind: r.design ? 'design-shot' : 'screenshot', ref: r.id }, { kind: 'retained', ref: r.key }]),
    { kind: 'capture', ref: capturedSha.toLowerCase() },
    ...(read?.ok && read.design && designShots.length ? [{ kind: 'design', ref: `${read.design.kind}:${read.design.ref}@${read.design.version}` }] : []),
  ];
  const retainUntil = new Date(deps.now().getTime() + VISUAL_EVIDENCE_RETENTION_DAYS * DAY_MS).toISOString();
  return recordAuditedVerdict(subject.id, {
    criterionId,
    verdict: verdict as Verdict,
    headSha: head,
    auditTaskId: audit.id,
    evidence: { refs, checker: 'visual', capturedSha: capturedSha.toLowerCase(), retainUntil, ...(observed ? { observed } : {}) },
  });
}
