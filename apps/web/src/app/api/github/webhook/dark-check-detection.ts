import { db } from '@buildd/core/db';
import { darkCheckAlerts, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { notify } from '@/lib/pushover';
import { githubApi } from '@/lib/github';
import { triggerEvent, channels } from '@/lib/pusher';
import { workspaceRepoMatches } from '@/lib/repo-scope';

const DEFAULT_THRESHOLD = 5;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DarkCheckParams {
  workspaceId: string;
  workspaceName: string;
  installationId: number;
  repoFullName: string;
  headSha: string;
  /** The branch the PR targeted — its protection rules define what is required. */
  baseBranch: string;
  threshold?: number;
}

/**
 * Resolves the status checks the base branch actually requires. Reads both the
 * modern `checks[].context` list and the deprecated `contexts` array, since
 * GitHub populates them inconsistently across protection and ruleset configs.
 *
 * Returns null when protection is unreadable, and an empty set when the branch
 * is protected but gates nothing — both mean "no required checks to judge".
 */
async function fetchRequiredCheckNames(
  installationId: number,
  repoFullName: string,
  baseBranch: string,
): Promise<Set<string> | null> {
  try {
    const [owner, repoName] = repoFullName.split('/');
    const protection = await githubApi(
      installationId,
      `/repos/${owner}/${repoName}/branches/${encodeURIComponent(baseBranch)}/protection`,
    );
    const required = protection?.required_status_checks;
    const names = [
      ...(Array.isArray(required?.checks)
        ? required.checks.map((c: { context?: string }) => c?.context)
        : []),
      ...(Array.isArray(required?.contexts) ? required.contexts : []),
    ].filter((n): n is string => typeof n === 'string' && n.length > 0);
    return new Set(names);
  } catch {
    // Branch protection not configured, or the app lacks admin:repo scope.
    return null;
  }
}

/**
 * Detects required CI checks that consistently report 'skipped' — a dark-check
 * pattern where a misconfigured check silently bypasses required CI gates.
 *
 * Fires a Pushover alert when the same check has been skipped on N consecutive
 * closed/merged PRs (default N=5). Deduplicates alerts to once per 24h per
 * (workspace, checkName) pair. Non-fatal: any error is logged, never thrown.
 *
 * Only checks that the PR's base branch *requires* are tracked. A skipped
 * optional workflow (path-filtered, `if:`-gated, or a manual job) is intended
 * behaviour, not a dark gate — counting those produced alerts naming checks no
 * branch ever required.
 */
export async function detectDarkChecks({
  workspaceId,
  workspaceName,
  installationId,
  repoFullName,
  headSha,
  baseBranch,
  threshold = DEFAULT_THRESHOLD,
}: DarkCheckParams): Promise<void> {
  try {
    // 1. Only the base branch's required checks can be dark. If protection is
    //    unreadable or gates nothing, there is nothing to judge — stay quiet
    //    rather than treating every optional workflow as a required one.
    const requiredCheckNames = await fetchRequiredCheckNames(
      installationId,
      repoFullName,
      baseBranch,
    );
    if (!requiredCheckNames || requiredCheckNames.size === 0) return;

    // 2. Fetch check runs for this PR's head SHA.
    let checkRuns: Array<{ name: string; conclusion: string | null }>;
    try {
      const data = await githubApi(
        installationId,
        `/repos/${repoFullName}/commits/${headSha}/check-runs`,
      );
      checkRuns = (data?.check_runs ?? []).map((run: { name: string; conclusion?: string | null }) => ({
        name: String(run.name),
        conclusion: run.conclusion ?? null,
      }));
    } catch (err) {
      console.warn(`[dark-check] Failed to fetch check runs for ${repoFullName}@${headSha}:`, err);
      return;
    }

    if (checkRuns.length === 0) return;

    // 3. Collapse to one verdict per required check name. A name can have many
    //    runs on the same SHA (re-runs, matrix legs, both a PR and a push
    //    event) — one PR must move its counter by at most one. A name counts as
    //    skipped only when every run of it skipped; a name with any run still
    //    unconcluded is evidence of nothing and is left untouched.
    const verdicts = new Map<string, { allSkipped: boolean; pending: boolean }>();
    for (const run of checkRuns) {
      if (!requiredCheckNames.has(run.name)) continue;
      const v = verdicts.get(run.name) ?? { allSkipped: true, pending: false };
      if (run.conclusion === null) v.pending = true;
      else if (run.conclusion !== 'skipped') v.allSkipped = false;
      verdicts.set(run.name, v);
    }

    if (verdicts.size === 0) return;

    const now = new Date();

    // 4. Update consecutive-skip counters per check name.
    for (const [checkName, verdict] of verdicts) {
      if (verdict.pending) continue;
      const isSkipped = verdict.allSkipped;

      const existing = await db.query.darkCheckAlerts.findFirst({
        where: and(
          eq(darkCheckAlerts.workspaceId, workspaceId),
          eq(darkCheckAlerts.checkName, checkName),
        ),
      });

      const newCount = isSkipped ? (existing?.consecutiveSkips ?? 0) + 1 : 0;

      if (existing) {
        await db
          .update(darkCheckAlerts)
          .set({ consecutiveSkips: newCount, updatedAt: now })
          .where(
            and(
              eq(darkCheckAlerts.workspaceId, workspaceId),
              eq(darkCheckAlerts.checkName, checkName),
            ),
          );
      } else {
        await db.insert(darkCheckAlerts).values({
          workspaceId,
          checkName,
          consecutiveSkips: newCount,
          updatedAt: now,
        });
      }

      // 5. Alert if threshold reached and not recently alerted (24h dedup).
      if (newCount >= threshold) {
        const lastAlerted = existing?.lastAlertedAt;
        const shouldAlert =
          !lastAlerted || now.getTime() - lastAlerted.getTime() > DEDUP_WINDOW_MS;

        if (shouldAlert) {
          // Stamp lastAlertedAt before firing to prevent concurrent duplicate alerts.
          await db
            .update(darkCheckAlerts)
            .set({ lastAlertedAt: now, updatedAt: now })
            .where(
              and(
                eq(darkCheckAlerts.workspaceId, workspaceId),
                eq(darkCheckAlerts.checkName, checkName),
              ),
            );

          notify({
            app: 'alerts',
            title: `Dark check detected — ${workspaceName}`,
            message: `Required check '${checkName}' has been Skipped on ${newCount} consecutive closed PRs — may be misconfigured.`,
            priority: 0,
          });

          // Emit workspace event so it surfaces in real-time dashboard feed.
          triggerEvent(channels.workspace(workspaceId), 'workspace:dark_check_detected', {
            workspaceId,
            checkName,
            consecutiveSkips: newCount,
          }).catch(e => console.error('[dark-check] Pusher event failed:', e));

          console.log(
            `[dark-check] Alert fired: workspace=${workspaceId} check="${checkName}" consecutiveSkips=${newCount}`,
          );
        }
      }
    }
  } catch (err) {
    console.error('[dark-check] detectDarkChecks failed (non-fatal):', err);
  }
}

/**
 * Entry point called from the GitHub webhook on PR close/merge. Looks up the
 * workspace for the repo and delegates to detectDarkChecks.
 */
export async function detectDarkChecksForClosedPr(
  installationId: number,
  repoFullName: string,
  headSha: string,
  baseBranch: string,
): Promise<void> {
  const workspace = await db.query.workspaces.findFirst({
    where: workspaceRepoMatches(repoFullName),
    columns: { id: true, name: true },
  });
  if (!workspace) return;

  await detectDarkChecks({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    installationId,
    repoFullName,
    headSha,
    baseBranch,
  });
}
