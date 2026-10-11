/**
 * Needs You admission for `post_note type=question` (design:
 * packages/core/needs-you.ts). An agent's question note is
 * non-blocking, but it renders as a human ask (the task page's question feed,
 * the DECIDE chip), so it passes the same deterministic gate a parked question
 * does before it is stored: the hard rails, then stage 0
 * (lib/question-gate-check.ts `recheckParkedQuestion`). A recoverable platform
 * blocker files or reuses a repair task and the note is stored already
 * answered with disposition `recovered`; everything else is stored `ask`.
 *
 * Only notes written by an agent or an outside caller are gated
 * (`noteQuestionNeedsDisposition`); a person's or the system's own notes get
 * no disposition. Never throws: a failure stores `ask`.
 */
import { eq } from 'drizzle-orm';
import { noteQuestionNeedsDisposition } from '@buildd/core/needs-you';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { gateEnabledFromGitConfig, hardRailContextFromGitConfig, recheckParkedQuestion, type QuestionCheckDeps } from './question-gate-check';

export interface QuestionNoteInput {
  type: string;
  authorType: string;
  title: string;
  bodyText?: string | null;
  defaultChoice?: string | null;
  workspaceId: string | null;
  missionId: string | null;
  taskId: string | null;
  workerId: string | null;
}

export interface QuestionNoteContext {
  teamId: string | null;
  dataClass: string | null;
  gitConfig: WorkspaceGitConfig | null;
  task: { title: string | null; pathManifest: string[] | null; missionId: string | null; accountId?: string | null } | null;
}

export interface QuestionNoteDisposition {
  /** Null: not a gated question note. */
  disposition: 'ask' | 'recovered' | null;
  repairTaskId?: string;
  rail?: string;
  /** For the posting agent, when it was not shown to a person. */
  reason?: string;
}

export interface QuestionNoteDeps extends Pick<QuestionCheckDeps, 'fileRepair' | 'record'> {
  loadContext?: (input: QuestionNoteInput) => Promise<QuestionNoteContext>;
}

async function defaultLoadContext(input: QuestionNoteInput): Promise<QuestionNoteContext> {
  const { db } = await import('@buildd/core/db');
  const { tasks, workspaces } = await import('@buildd/core/db/schema');
  const [ws, task] = await Promise.all([
    input.workspaceId
      ? db.query.workspaces.findFirst({ where: eq(workspaces.id, input.workspaceId), columns: { teamId: true, dataClass: true, gitConfig: true } })
      : null,
    input.taskId
      ? db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId), columns: { title: true, pathManifest: true, missionId: true } })
      : null,
  ]);
  return {
    teamId: ws?.teamId ?? null,
    dataClass: ws?.dataClass ?? null,
    gitConfig: (ws?.gitConfig as WorkspaceGitConfig | null) ?? null,
    task: task ? { title: task.title ?? null, pathManifest: (task.pathManifest as string[] | null) ?? null, missionId: task.missionId ?? null } : null,
  };
}

export async function disposeQuestionNote(input: QuestionNoteInput, deps: QuestionNoteDeps = {}): Promise<QuestionNoteDisposition> {
  if (!noteQuestionNeedsDisposition(input)) return { disposition: null };
  try {
    const ctx = await (deps.loadContext ?? defaultLoadContext)(input);
    // A repair needs a blocked task to name; without one, or without a team
    // to record against, the note is simply asked.
    if (!input.taskId || !input.workspaceId || !ctx.teamId) return { disposition: 'ask' };
    const gitConfig = ctx.gitConfig;
    const d = await recheckParkedQuestion(
      {
        teamId: ctx.teamId,
        workspaceId: input.workspaceId,
        accountId: null,
        taskId: input.taskId,
        missionId: input.missionId ?? ctx.task?.missionId ?? null,
        workerId: input.workerId ?? '',
        taskTitle: ctx.task?.title ?? null,
        sensitive: ctx.dataClass === 'sensitive',
        gateEnabled: gateEnabledFromGitConfig(gitConfig),
        hardRail: { ...hardRailContextFromGitConfig(gitConfig), pathManifest: ctx.task?.pathManifest ?? null },
      },
      {
        prompt: input.title,
        ...(input.bodyText ? { context: input.bodyText } : {}),
        ...(input.defaultChoice ? { recommended: { label: input.defaultChoice } } : {}),
      },
      { fileRepair: deps.fileRepair, record: deps.record },
    );
    if (d.disposition === 'recovered' && d.repairTaskId) {
      return { disposition: 'recovered', repairTaskId: d.repairTaskId, ...(d.reason ? { reason: d.reason } : {}) };
    }
    return { disposition: 'ask', ...(d.rail ? { rail: d.rail } : {}) };
  } catch {
    return { disposition: 'ask' };
  }
}

/** The created note, plus — when the gate kept it from a person — what the posting agent should do instead. */
export function gatedNoteResponse<T extends object>(note: T, gated: QuestionNoteDisposition): T & { gate?: { disposition: 'recovered'; repairTaskId?: string; reason?: string } } {
  if (gated.disposition !== 'recovered') return note;
  return { ...note, gate: { disposition: 'recovered', repairTaskId: gated.repairTaskId, reason: gated.reason } };
}
