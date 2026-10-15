/**
 * buildd's merge rails as the kernel's `Rails` port
 * (docs/specs/workflow-kernel-library.md §4): read by the `merge_call` effect
 * at merge time, against the head it is about to merge, instead of trusted
 * from the door that asked (the old `rails: { passed: true }`).
 *
 * The rails are the ones every door already runs, read through one function:
 * `evaluateAutoMergeSafety` (CI on the head, protected paths, the size cap,
 * the migration inspector, the semantic hold, the mergeable state) with base
 * freshness left to T15/S15 and to GitHub's own `behind` answer, plus the
 * mission-PR hold (`guardMissionPrMerge`, a module's, handed in by the
 * composition root). The review verdict is not a rail: the kernel's own
 * delivery state answers it (landing-gate.ts).
 *
 * Fail closed: a rail that cannot be read refuses.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import type { MergePolicy } from '@buildd/shared';
import type { RailReading, Rails } from '@buildd/workflow-kernel/ports';
import { classifyAutoMergeRefusal, evaluateAutoMergeSafety } from '@/lib/auto-merge';
import type { CheckRunState } from '@/lib/auto-merge-bound';
import { isFailingCheckRun } from '@/lib/ci-verdict';
import { RESOLVE_POLICY_MISSION_COLUMNS, resolvePolicy } from '@/lib/merge-policy';
import { workspaceRepo } from './github-facts';

/** The owner task, as the mission-PR hold reads it. */
export interface RailsOwnerTask { title?: string | null; taskClass?: string | null; missionId?: string | null }

export interface LandingRailsDeps {
  /** The mission-PR hold (lib/mission-pr.ts `guardMissionPrMerge`), from the composition root. */
  missionGate: (task: RailsOwnerTask | null) => Promise<{ blocks: boolean; reason?: string | null }>;
  safety?: typeof evaluateAutoMergeSafety;
  repoFor?: typeof workspaceRepo;
  load?: (workspaceId: string, ownerTaskId: string) => Promise<RailsContext | null>;
}

export interface RailsContext {
  gitConfig: WorkspaceGitConfig | null;
  releaseConfig: WorkspaceReleaseConfig | null;
  task: (RailsOwnerTask & { id: string; requiresReview?: boolean | null; mission?: Record<string, unknown> | null }) | null;
}

async function loadContext(workspaceId: string, ownerTaskId: string): Promise<RailsContext | null> {
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { gitConfig: true, releaseConfig: true } });
  if (!ws) return null;
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, ownerTaskId)),
    columns: { id: true, title: true, taskClass: true, missionId: true, requiresReview: true },
    with: { mission: { columns: RESOLVE_POLICY_MISSION_COLUMNS } },
  });
  return {
    gitConfig: (ws.gitConfig ?? null) as WorkspaceGitConfig | null,
    releaseConfig: (ws.releaseConfig ?? null) as WorkspaceReleaseConfig | null,
    task: (task ?? null) as RailsContext['task'],
  };
}

export function builddLandingRails(deps: LandingRailsDeps): Rails {
  const safety = deps.safety ?? evaluateAutoMergeSafety;
  const repoFor = deps.repoFor ?? workspaceRepo;
  const load = deps.load ?? loadContext;
  return {
    async evaluate(d, p): Promise<RailReading> {
      const repo = await repoFor(d.workspaceId);
      if (!repo) return { passed: false, reasons: ['no GitHub installation for the workspace'] };
      const ctx = await load(d.workspaceId, d.ownerTaskId);
      if (!ctx) return { passed: false, reasons: ['the workspace could not be read'] };
      const mission = (ctx.task?.mission ?? null) as Parameters<typeof resolvePolicy>[1];
      const resolved: MergePolicy = resolvePolicy({ gitConfig: ctx.gitConfig }, mission, ctx.task ? { requiresReview: ctx.task.requiresReview === true } : null, { baseRef: p.live.baseRef });
      // A person's size override lifts the size cap, and nothing else (as the doors read it).
      const policy: MergePolicy = p.override?.kinds?.includes('size')
        ? { ...resolved, threshold: { ...resolved.threshold, maxLines: Number.MAX_SAFE_INTEGER } as MergePolicy['threshold'] }
        : resolved;
      const observed: { checkRuns?: CheckRunState[] } = {};
      const verdict = await safety(repo.installationId, d.repoFullName, d.prNumber, p.headSha, policy, {
        mission: mission as never,
        releaseConfig: ctx.releaseConfig,
        workspaceId: d.workspaceId,
        taskId: d.ownerTaskId,
        // Freshness is T15's (S15) and GitHub's own `behind` answer, never a rail here.
        skipBaseFreshness: true,
        gitConfig: ctx.gitConfig,
        observed,
        // A person's door: the rails a person merges under, not the unattended ones.
        ...(p.person ? { personDecides: true } : {}),
      });
      if (!verdict.ok) {
        const cls = classifyAutoMergeRefusal(verdict.reason);
        const redCi = cls === 'ci' && (observed.checkRuns ?? []).some(isFailingCheckRun);
        // Lasting: it will not clear by waiting, so a person decides (and is told which rail).
        // CI (pending or red, which the CI family repairs), a read, a moved head or a hold waits.
        const lasting = cls === 'deny_path' || cls === 'size' || cls === 'blocked'
          || (cls === 'migration' && !/^could not /.test(verdict.reason) && !/snapshot parent is no longer a leaf/.test(verdict.reason));
        return {
          passed: false, reasons: [verdict.reason],
          ...(redCi ? { redCi: true } : {}), ...(cls === 'deny_path' ? { denyPaths: true } : {}), ...(cls === 'size' ? { sizeOnly: true } : {}),
          ...(lasting ? { lasting: true } : {}),
        };
      }
      const hold = await deps.missionGate(ctx.task);
      if (hold.blocks) return { passed: false, reasons: [hold.reason ?? 'mission work is not finished'] };
      return { passed: true, reasons: [] };
    },
  };
}
