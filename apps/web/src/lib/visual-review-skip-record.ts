/**
 * Every visual review Skip, recorded centrally (spec 072de598 I-7, I-19, AC-26).
 *
 * A Skip is a person's bypass of the visual review gate, so it lands in the
 * existing gate ledger (`gate_events`, gate `visual_review_skip`, outcome
 * `bypassed`) with the button pressed, the person, the mission, the commit and
 * the open findings. Visual review's reliability is read back from those rows
 * (`visual-review-reliability.ts`).
 *
 * "The review is wrong or stuck" also files one visual-review bug through the
 * existing friction machinery: a `[friction]` task whose `frictionSignature`
 * names the cause, so a cause that recurs appends each occurrence to the one
 * open bug instead of filing another. "Ship it anyway" files nothing; its
 * findings stay listed under the Skip as accepted.
 *
 * The snapshot is read BEFORE the waiver is written: once recorded, the review
 * reads waived and its queued audit is cancelled, which would hide the cause.
 */
import type { VisualReviewModel } from '@buildd/shared';
import { VISUAL_REVIEW_SKIP_REASONS, type VisualReviewSkipReason } from '@buildd/core/surface-audit';
import type { MissionVisualReviewState } from '@/lib/workflow/visual-review-state';

/** Why the review was wrong or stuck, read off its state when the person skipped it. One open bug per cause. */
export type VisualReviewSkipCause =
  | 'app_boot_failed' | 'no_browser_runner' | 'stalled' | 'auditor_failed' | 'capture_setup' | 'preview_unavailable'
  | 'waiting_on_failed_work' | 'never_started' | 'still_running' | 'fix_not_rechecked' | 'findings_wrong' | 'unknown';

/** The cause in words, for the bug title and the Health readout. */
export const VISUAL_REVIEW_SKIP_CAUSE_TEXT: Record<VisualReviewSkipCause, string> = {
  app_boot_failed: 'the app did not boot for the audit',
  no_browser_runner: 'no runner with a browser took the audit',
  stalled: 'the audit stalled',
  auditor_failed: 'the audit failed',
  capture_setup: 'the screenshot setup was refused',
  preview_unavailable: 'no preview to audit',
  waiting_on_failed_work: 'the audit waited on failed work',
  never_started: 'the audit never started',
  still_running: 'the audit kept running',
  fix_not_rechecked: 'a merged fix was never re-shot',
  findings_wrong: 'the findings were wrong',
  unknown: 'no cause could be read',
};

export function visualReviewSkipCause(state: MissionVisualReviewState | null): VisualReviewSkipCause {
  if (!state) return 'unknown';
  if (state.status === 'blocked' && state.blocked) {
    switch (state.blocked.cause) {
      case 'app_boot_failed': return 'app_boot_failed';
      case 'no_browser_runner': return 'no_browser_runner';
      case 'stalled': return 'stalled';
      case 'auditor_failed': return 'auditor_failed';
      case 'capture_auth': return 'capture_setup';
      case 'preview_unavailable': return 'preview_unavailable';
      default: return 'unknown';
    }
  }
  if (state.waitingOn) return 'waiting_on_failed_work';
  if (state.recapture?.next === 'decide') return 'fix_not_rechecked';
  if (state.status === 'findings') return 'findings_wrong';
  if (state.status === 'running') return 'still_running';
  if (state.status === 'queued' || state.status === 'needed') return 'never_started';
  return 'unknown';
}

/** One open finding as the record carries it: where, what, and the screenshot. */
export interface SkipFinding { route: string; viewport: string; state: string | null; finding: string; screenshot: string }

/** What the review looked like the moment before the Skip was written. */
export interface VisualReviewSkipSnapshot {
  commit: string | null;
  cause: VisualReviewSkipCause;
  findings: SkipFinding[];
  /** Open findings in all; `findings` keeps the first few. */
  openFindings: number;
}

const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 160;

/** The open findings of a model: the current screens a person or the agent judged an issue. */
export function openFindingsOf(model: Pick<VisualReviewModel, 'cells'> | null): SkipFinding[] {
  if (!model) return [];
  return model.cells
    .filter(c => c.effectiveVerdict === 'issue' && c.standing !== 'fine')
    .map(c => ({
      route: c.route,
      viewport: c.viewport,
      state: c.variant ?? null,
      finding: (c.current.finding ?? '').slice(0, MAX_FINDING_CHARS),
      screenshot: c.current.shot.src,
    }));
}

export function skipSnapshotOf(state: MissionVisualReviewState | null, model: Pick<VisualReviewModel, 'cells'> | null): VisualReviewSkipSnapshot {
  const findings = openFindingsOf(model);
  return {
    commit: state?.branch.headSha ?? state?.evidenceSha ?? null,
    cause: visualReviewSkipCause(state),
    findings: findings.slice(0, MAX_FINDINGS),
    openFindings: findings.length,
  };
}

/** Read the review as it stands before the waiver is written. Never throws: an unreadable review is recorded as such. */
export async function snapshotVisualReviewForSkip(missionId: string, workspaceId: string | null): Promise<VisualReviewSkipSnapshot> {
  try {
    const { loadVisualReview } = await import('@/lib/visual-review-load');
    const model = await loadVisualReview({ id: missionId, workspaceId });
    const { getMissionVisualReviewState } = await import('@/lib/workflow/visual-review-state-load');
    // As if no Skip stood, so the record names what the person was looking at.
    const state = await getMissionVisualReviewState(missionId, { model, waiver: Promise.resolve(null), render: true });
    return skipSnapshotOf(state, model);
  } catch (err) {
    console.error(`[visual-review-skip] ${missionId.slice(0, 8)} snapshot failed (recorded without it):`, err);
    return { commit: null, cause: 'unknown', findings: [], openFindings: 0 };
  }
}

/** The friction signature that folds every wrong-or-stuck Skip of one cause into one bug. */
export function visualReviewSkipSignature(cause: VisualReviewSkipCause): string {
  return `visual-review-skip:${cause}`;
}

export interface RecordSkipInput {
  mission: { id: string; title: string; workspaceId: string | null };
  /** The button; null for a free-text waiver (the decision sheet, an API caller). */
  skipReason: VisualReviewSkipReason | null;
  note: string | null;
  actorLabel: string | null;
  callerOrigin: 'api' | 'dashboard' | 'worker' | 'system';
  snapshot: VisualReviewSkipSnapshot;
}

export interface RecordSkipDeps {
  recordGateEvent(e: {
    gate: string; surface: string; outcome: 'bypassed'; reason: string;
    workspaceId: string | null; missionId: string; taskId?: string | null; detail: Record<string, unknown>; callerOrigin: RecordSkipInput['callerOrigin'];
  }): Promise<unknown>;
  /** The open `[friction]` task carrying this signature in the workspace, or null. */
  findOpenBug(workspaceId: string, signature: string): Promise<{ id: string } | null>;
  appendToBug(taskId: string, text: string): Promise<void>;
  fileBug(row: { workspaceId: string; title: string; description: string; signature: string; excerpt: string; missionId: string }): Promise<{ id: string } | null>;
}

export interface RecordSkipResult { bug: { taskId: string; outcome: 'created' | 'appended' } | null }

/** The bug's body for one occurrence: mission, commit, person, note, findings with their screenshots. */
export function skipOccurrenceText(input: RecordSkipInput, at: Date): string {
  const s = input.snapshot;
  const lines = [
    `Mission: "${input.mission.title}" (${input.mission.id.slice(0, 8)}, /app/missions/${input.mission.id})`,
    `Commit: ${s.commit ? s.commit.slice(0, 12) : 'unknown'}`,
    `Skipped by: ${input.actorLabel ?? 'a person'} at ${at.toISOString()}`,
    `Cause read from the review: ${VISUAL_REVIEW_SKIP_CAUSE_TEXT[s.cause]}`,
    ...(input.note ? [`Their note: ${input.note}`] : []),
    s.openFindings === 0 ? 'Open findings: none' : `Open findings (${s.openFindings}):`,
    ...s.findings.map(f => `- ${f.route} · ${f.state ? `${f.state} · ` : ''}${f.viewport}: ${f.finding || '(no text)'} (screenshot ${f.screenshot})`),
    ...(s.openFindings > s.findings.length ? [`- and ${s.openFindings - s.findings.length} more`] : []),
  ];
  return lines.join('\n');
}

export async function recordVisualReviewSkip(input: RecordSkipInput, deps?: RecordSkipDeps, now = new Date()): Promise<RecordSkipResult> {
  const d = deps ?? await defaultDeps();
  const { mission, snapshot } = input;
  const wrongOrStuck = input.skipReason === 'wrong_or_stuck';
  let bug: RecordSkipResult['bug'] = null;

  if (wrongOrStuck && mission.workspaceId) {
    try {
      const signature = visualReviewSkipSignature(snapshot.cause);
      const text = skipOccurrenceText(input, now);
      const open = await d.findOpenBug(mission.workspaceId, signature);
      if (open) {
        await d.appendToBug(open.id, `\n\n---\n_Skipped again as wrong or stuck._\n${text}`);
        bug = { taskId: open.id, outcome: 'appended' };
      } else {
        const filed = await d.fileBug({
          workspaceId: mission.workspaceId,
          missionId: mission.id,
          signature,
          excerpt: VISUAL_REVIEW_SKIP_CAUSE_TEXT[snapshot.cause],
          title: `[friction] visual review wrong or stuck: ${VISUAL_REVIEW_SKIP_CAUSE_TEXT[snapshot.cause]}`.slice(0, 200),
          description: [
            'A person skipped a mission\'s visual review with "The review is wrong or stuck". Each later Skip with the same cause is added below, so this bug collects every occurrence (spec 072de598 I-19).',
            '',
            text,
            '',
            'Find what made the review wrong or stuck for this cause and fix it in the visual review pipeline (apps/web/src/lib/workflow/visual-review-*.ts, the visual auditor, scripts/qa/). Reliability is read over MCP with get_failure_analytics and on Health.',
          ].join('\n'),
        });
        if (filed) bug = { taskId: filed.id, outcome: 'created' };
      }
    } catch (err) {
      console.error(`[visual-review-skip] ${mission.id.slice(0, 8)} filing the visual-review bug failed:`, err);
    }
  }

  await d.recordGateEvent({
    gate: 'visual_review_skip',
    surface: 'PATCH /api/missions/[id]',
    outcome: 'bypassed',
    reason: `visual review skipped: ${input.skipReason ?? 'reason'}`,
    workspaceId: mission.workspaceId,
    missionId: mission.id,
    taskId: bug?.taskId ?? null,
    callerOrigin: input.callerOrigin,
    detail: {
      skipReason: input.skipReason,
      label: input.skipReason ? VISUAL_REVIEW_SKIP_REASONS[input.skipReason] : null,
      note: input.note ? input.note.slice(0, 300) : null,
      actor: input.actorLabel,
      commit: snapshot.commit,
      cause: snapshot.cause,
      openFindings: snapshot.openFindings,
      findings: snapshot.findings,
      ...(bug ? { bugTaskId: bug.taskId, bugOutcome: bug.outcome } : {}),
    },
  });
  return { bug };
}

async function defaultDeps(): Promise<RecordSkipDeps> {
  const [{ db }, { tasks }, { and, eq, like, notInArray, sql }, { sqlWhere }, { recordGateEvent, GATE_SLUGS }, { TERMINAL_TASK_STATUSES }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@buildd/core/db/relational-sql'),
    import('@buildd/core/gate-events'),
    import('@buildd/shared'),
  ]);
  return {
    recordGateEvent: (e) => recordGateEvent({ ...e, gate: GATE_SLUGS.VISUAL_REVIEW_SKIP }),
    findOpenBug: async (workspaceId, signature) => (await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.workspaceId, workspaceId),
        like(tasks.title, '[friction] %'),
        sql`${tasks.context}->>'frictionSignature' = ${signature}`,
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      )),
      columns: { id: true },
    })) ?? null,
    appendToBug: async (taskId, text) => {
      await db.update(tasks).set({ description: sql`${tasks.description} || ${text}`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    },
    fileBug: async (row) => {
      // Not filed into the mission: the bug is about visual review, not the mission's work.
      const [inserted] = await db.insert(tasks).values({
        workspaceId: row.workspaceId,
        title: row.title,
        description: row.description,
        priority: 5,
        status: 'pending',
        mode: 'execution',
        taskClass: 'work',
        kind: 'engineering',
        creationSource: 'dashboard',
        category: 'bug',
        context: { frictionSignature: row.signature, frictionExcerpt: row.excerpt, relatedMissionId: row.missionId },
      }).returning({ id: tasks.id });
      if (inserted?.id) {
        const { wakeTask } = await import('@/lib/dispatch-authority');
        await wakeTask(inserted.id, 'task.created');
      }
      return inserted ?? null;
    },
  };
}
