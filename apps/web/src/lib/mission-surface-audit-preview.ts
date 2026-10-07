import { resolveVisualQaConfig } from '@buildd/core/visual-qa-page-source';
import { captureTrunk, resolveVisualQaCaptureRef } from '@buildd/core/visual-qa-capture-ref';
import { planMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { loadBrowserRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { browserRunnerOnline } from '@/lib/visual-audit-runner';
import type { VisualReviewPreview } from '@/lib/mission-visual-review-request';

export type SurfaceAuditPreviewResult =
  | { ok: true; preview: VisualReviewPreview }
  | { ok: false; reason: 'mission_not_found' | 'mission_closed' | 'no_workspace' };

/**
 * The facts the mission page's Visual review sheet shows before anything is
 * filed: the screens a new audit would be scoped to, where its pages would
 * come from, and whether a browser-capable runner is online to take it. Read
 * from `planMissionSurfaceAudit`, the same plan "Run visual review" acts on.
 */
export async function previewMissionSurfaceAudit(missionId: string, now = Date.now()): Promise<SurfaceAuditPreviewResult> {
  const plan = await planMissionSurfaceAudit(missionId);
  if (!plan.ok) return plan;
  const executorLocal = plan.mission.executor === 'local';
  if (plan.live) {
    return {
      ok: true,
      preview: {
        existing: { taskId: plan.live.id, status: plan.live.status },
        routes: [],
        viewports: ['mobile', 'desktop'],
        capture: null,
        browserRunnerOnline: null,
        executorLocal,
      },
    };
  }

  const ws = plan.targetWorkspace;
  const gitConfig = (ws.gitConfig ?? null) as { visualQa?: unknown; targetBranch?: string; defaultBranch?: string } | null;
  const config = resolveVisualQaConfig(gitConfig?.visualQa);
  const ref = resolveVisualQaCaptureRef({ mission: plan.mission, trunk: captureTrunk(gitConfig) });
  // Null (unknown) on a failed read: the sheet then says nothing about runners.
  const hbs = await loadBrowserRunnerHeartbeats(ws, now).catch(() => null);

  return {
    ok: true,
    preview: {
      existing: null,
      routes: plan.requiredRoutes,
      viewports: ['mobile', 'desktop'],
      capture: {
        branch: ref.source === 'mission_integration' ? 'mission' : 'trunk',
        ref: ref.ref,
        pageSource: config.pageSource,
      },
      browserRunnerOnline: hbs ? browserRunnerOnline(hbs, ws.id, now) : null,
      executorLocal,
    },
  };
}
