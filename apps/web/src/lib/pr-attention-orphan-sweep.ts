/**
 * Orphan-PR sweep (pr-merge-reliability M3, "No orphan PRs").
 *
 * Every per-PR surface (explain, get_pr, get_pr_review, the landing sweep, the
 * needs-you inbox) finds a PR through the worker row that holds its number, or
 * the kernel delivery for it. A PR opened outside create_pr (a plain
 * `gh pr create` from a session, often on a branch it named itself) has
 * neither: the webhook's `registerLocalPr` binds it only to a worker on that
 * exact branch with no PR yet, so a second or third PR from one task on its own
 * hand-named branch stays open with no reviewer, no owner and no needs-you
 * item. `explain` 404s it and nothing else ever looks at it.
 *
 * This sweep lists each active workspace's open PRs on GitHub and, for one on a
 * `buildd/<task8>-…` head in the same repo that no worker or delivery holds:
 *   1. adopts it onto the one task that prefix names (a PR-only owner row,
 *      `insertPrOwnerRow`), so every surface resolves it from now on;
 *   2. files one needs-you item for it: a person decides whether it lands, is
 *      superseded by the task's other PR, or is closed.
 *
 * Adoption is what makes the item one per PR: an adopted PR is owned, so the
 * next sweep skips it. Nothing is closed, merged or reviewed here; a prefix that
 * names no task, or more than one, is counted and left alone.
 *
 * Why a task prefix suffices here when `registerLocalPr` refuses it: that path
 * runs on every webhook for any branch, and a prefix there would hand a worker
 * the PR's merge authority. Here the head must be a branch of the workspace's
 * own repo (pushing one needs write access to it), and the only consequence is
 * an owner row plus a question to a person.
 */

import { and, desc, eq, inArray, isNotNull, gte, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { githubApi } from '@/lib/github';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity } from '@/lib/workspace-installation';
import { kernelDeliveryForPr } from '@/lib/workflow/authority';
import { insertPrOwnerRow, otherOpenTaskPrs } from '@/lib/worker-pr-slot';
import { notifyTeamOf } from '@/lib/notify';

/** A PR younger than this may still be mid-create_pr (GitHub first, our row after). */
export const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
/** Workspaces that opened an agent PR within this window are swept. */
export const ORPHAN_WORKSPACE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSPACE_CAP = 50;
const PAGES_PER_REPO = 3;
/** One action per PR per sweep, and a bound on actions per sweep. */
const ADOPT_CAP = 20;

const TASK_HEAD_RE = /^buildd\/([0-9a-f]{8})-/;

export interface OpenGithubPr {
  number: number;
  html_url: string;
  created_at: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

export interface SweptWorkspace { id: string; teamId: string | null; fullName: string; installationId: number }

export interface OrphanTask { id: string; title: string; missionId: string | null; accountId: string | null }

export interface OrphanSweepDeps {
  listWorkspaces(now: Date): Promise<SweptWorkspace[]>;
  listOpenPrs(ws: SweptWorkspace): Promise<OpenGithubPr[]>;
  /** The PR numbers among `numbers` that a worker or delivery row holds. */
  ownedPrNumbers(ws: SweptWorkspace, numbers: number[]): Promise<Set<number>>;
  /** The one task in the workspace whose id starts with `prefix`; null when none or several. */
  findTaskByPrefix(workspaceId: string, prefix: string): Promise<OrphanTask | null>;
  adopt(ws: SweptWorkspace, task: OrphanTask, pr: OpenGithubPr): Promise<string | null>;
  fileNeedsYou(ws: SweptWorkspace, task: OrphanTask, pr: OpenGithubPr, ownerWorkerId: string): Promise<void>;
  /** Undo `adopt` when the item could not be filed, so the next sweep tries both again. */
  release(ownerWorkerId: string): Promise<void>;
}

export interface OrphanSweepResult {
  workspaces: number;
  openAgentPrs: number;
  orphans: number;
  adopted: number;
  unattributed: number;
  deferred: number;
  errors: number;
}

/** The task-id prefix a `buildd/<task8>-…` head names, or null. */
export function taskPrefixFromHead(head: string | null | undefined): string | null {
  const m = head ? TASK_HEAD_RE.exec(head) : null;
  return m ? m[1] : null;
}

/** Open PRs that are agent PRs of this repo and old enough to be judged. */
export function agentPrCandidates(prs: OpenGithubPr[], repoFullName: string, now: Date, minAgeMs = ORPHAN_MIN_AGE_MS): OpenGithubPr[] {
  const repo = repoFullName.toLowerCase();
  return prs.filter(pr =>
    taskPrefixFromHead(pr.head?.ref) !== null &&
    pr.head?.repo?.full_name?.toLowerCase() === repo &&
    now.getTime() - new Date(pr.created_at).getTime() >= minAgeMs,
  );
}

export async function sweepOrphanAgentPrs(now: Date = new Date(), deps: OrphanSweepDeps = defaultDeps): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { workspaces: 0, openAgentPrs: 0, orphans: 0, adopted: 0, unattributed: 0, deferred: 0, errors: 0 };
  const sweptWorkspaces = await deps.listWorkspaces(now);
  result.workspaces = sweptWorkspaces.length;

  for (const ws of sweptWorkspaces) {
    let candidates: OpenGithubPr[];
    let owned: Set<number>;
    try {
      candidates = agentPrCandidates(await deps.listOpenPrs(ws), ws.fullName, now);
      result.openAgentPrs += candidates.length;
      if (candidates.length === 0) continue;
      owned = await deps.ownedPrNumbers(ws, candidates.map(p => p.number));
    } catch (err) {
      console.error(`[orphan-pr-sweep] could not read open PRs of ${ws.fullName}:`, err);
      result.errors++;
      continue;
    }

    for (const pr of candidates) {
      if (owned.has(pr.number)) continue;
      result.orphans++;
      if (result.adopted >= ADOPT_CAP) { result.deferred++; continue; }
      try {
        const task = await deps.findTaskByPrefix(ws.id, taskPrefixFromHead(pr.head.ref)!);
        if (!task) {
          result.unattributed++;
          console.warn(`[orphan-pr-sweep] ${ws.fullName}#${pr.number} (${pr.head.ref}) names no single task; left alone`);
          continue;
        }
        const ownerId = await deps.adopt(ws, task, pr);
        if (!ownerId) { result.errors++; continue; }
        // Adoption is what stops the next sweep from asking again, so an item
        // that failed to file must not leave the PR owned: release it and retry.
        try {
          await deps.fileNeedsYou(ws, task, pr, ownerId);
        } catch (err) {
          await deps.release(ownerId).catch(releaseErr =>
            console.error(`[orphan-pr-sweep] ${ws.fullName}#${pr.number}: could not release owner ${ownerId}:`, releaseErr));
          throw err;
        }
        result.adopted++;
        console.log(`[orphan-pr-sweep] adopted ${ws.fullName}#${pr.number} onto task ${task.id.slice(0, 8)} and asked a person`);
      } catch (err) {
        console.error(`[orphan-pr-sweep] ${ws.fullName}#${pr.number}:`, err);
        result.errors++;
      }
    }
  }
  return result;
}

/** The needs-you item's copy: what happened, and the three things a person can do. */
export function orphanNeedsYouNote(pr: { number: number; url: string; head: string }, others: Array<{ number: number }>): { title: string; body: string } {
  const siblings = others.length > 0
    ? `\n\nThis task also has open ${others.length === 1 ? 'PR' : 'PRs'} ${others.map(o => `#${o.number}`).join(', ')}. If one of them re-implements this one, record the supersession before closing it.`
    : '';
  return {
    title: `PR #${pr.number} — opened outside create_pr, nobody owns it`,
    body: `PR #${pr.number} (\`${pr.head}\`) is open, but no worker or delivery recorded it, so it was never reviewed and nothing was waiting on it. It is now attached to this task.${siblings}\n\nChoose one:\n- **Land it** — request a review: request_pr_review { prNumber: ${pr.number} }\n- **Close as superseded** — record_pr_supersession { prNumber: ${pr.number}, supersedingPrNumber: <newer>, reason }, then close it\n- **Abandon PR** — close it without replacement\n\nPR: ${pr.url}`,
  };
}

// ── Default deps: the database and GitHub ────────────────────────────────────

const defaultDeps: OrphanSweepDeps = {
  async listWorkspaces(now) {
    const recent = await db.selectDistinct({ workspaceId: workers.workspaceId })
      .from(workers)
      .where(and(isNotNull(workers.prNumber), gte(workers.createdAt, new Date(now.getTime() - ORPHAN_WORKSPACE_WINDOW_MS))))
      .limit(WORKSPACE_CAP);
    const ids = recent.map(r => r.workspaceId).filter((id): id is string => !!id);
    if (ids.length === 0) return [];
    const rows = await db.query.workspaces.findMany({
      where: sqlWhere(inArray(workspaces.id, ids)),
      columns: { id: true, teamId: true, repo: true },
      with: WORKSPACE_INSTALLATION_WITH,
    });
    const out: SweptWorkspace[] = [];
    for (const row of rows) {
      const identity = pickWorkspaceRepoIdentity(row);
      if (identity.fullName && identity.installationId) {
        out.push({ id: row.id, teamId: row.teamId ?? null, fullName: identity.fullName, installationId: identity.installationId });
      }
    }
    return out;
  },

  async listOpenPrs(ws) {
    const all: OpenGithubPr[] = [];
    for (let page = 1; page <= PAGES_PER_REPO; page++) {
      const batch = await githubApi(ws.installationId, `/repos/${ws.fullName}/pulls?state=open&per_page=100&page=${page}`) as OpenGithubPr[];
      if (!Array.isArray(batch)) break;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  },

  async ownedPrNumbers(ws, numbers) {
    const rows = await db.query.workers.findMany({
      where: sqlWhere(and(eq(workers.workspaceId, ws.id), inArray(workers.prNumber, numbers), isNotNull(workers.prUrl))),
      columns: { prNumber: true, prUrl: true },
    });
    const repoPath = `/${ws.fullName.toLowerCase()}/pull/`;
    const owned = new Set<number>();
    for (const r of rows) {
      if (r.prNumber && r.prUrl?.toLowerCase().includes(repoPath)) owned.add(r.prNumber);
    }
    for (const n of numbers) {
      if (!owned.has(n) && await kernelDeliveryForPr(ws.id, ws.fullName, n)) owned.add(n);
    }
    return owned;
  },

  async findTaskByPrefix(workspaceId, prefix) {
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(and(eq(tasks.workspaceId, workspaceId), sql`${tasks.id}::text LIKE ${`${prefix}%`}`)),
      columns: { id: true, title: true, missionId: true },
      limit: 2,
    });
    if (rows.length !== 1) return null;
    const last = await db.query.workers.findFirst({
      where: sqlWhere(eq(workers.taskId, rows[0].id)),
      columns: { accountId: true },
      orderBy: sqlOrderBy(desc(workers.createdAt)),
    });
    return { id: rows[0].id, title: rows[0].title, missionId: rows[0].missionId ?? null, accountId: last?.accountId ?? null };
  },

  async adopt(ws, task, pr) {
    return insertPrOwnerRow({
      workspaceId: ws.id,
      taskId: task.id,
      accountId: task.accountId,
      name: `orphan · PR #${pr.number}`,
      branch: pr.head.ref,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prBaseRef: pr.base?.ref ?? null,
    });
  },

  async release(ownerWorkerId) {
    // The row stays (its PR fact points at it); without the PR it owns nothing.
    await db.update(workers).set({ prNumber: null, prUrl: null }).where(eq(workers.id, ownerWorkerId));
  },

  // missionId may be null: the needs-you readers (lib/pr-attention.ts, the
  // home page) find reviewer_escalated notes by taskId, not by mission.
  async fileNeedsYou(ws, task, pr, ownerWorkerId) {
    const others = await otherOpenTaskPrs(task.id, pr.number).catch(() => []);
    const note = orphanNeedsYouNote({ number: pr.number, url: pr.html_url, head: pr.head.ref }, others);
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      workerId: ownerWorkerId,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: note.title,
      body: note.body,
      status: 'open',
    });
    void notifyTeamOf({ taskId: task.id, workspaceId: ws.id, prNumber: pr.number }, 'needsAttention', {
      title: 'A PR nobody owns',
      message: `${task.title}\nPR #${pr.number} was opened outside create_pr and never reviewed. Land it, close it as superseded, or abandon it.`,
      url: pr.html_url,
      urlTitle: `PR #${pr.number}`,
      priority: 0,
    });
  },
};
