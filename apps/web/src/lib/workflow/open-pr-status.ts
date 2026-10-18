/**
 * Every open PR head in a linked repo carries `Buildd / Review approval`
 * (docs/specs/workflow-kernel-library.md §4, "Every open PR carries it";
 * AC-37, AC-38). One step of the kernel floor (kernel-floor.ts), so it runs
 * hourly on whichever host runs the floor, and its first pass is the one-off
 * republish onto heads opened before the context existed: no manual migration.
 *
 * For each open PR (drafts included) of each linked repo, `openHeadStatus`
 * decides who answers:
 *  - the kernel, for a live delivery at that head: when GitHub does not show
 *    the kernel's answer under both names, a `publish_landing_status` effect
 *    is enqueued at the delivery's version and drained, so the effect's own
 *    newest-version-wins rule decides what is written (never this sweep);
 *  - a frozen release candidate: the release gate's answer at its SHA;
 *  - anything else (no delivery, a delivery that has not seen this head, one
 *    that is over): pending, "Review not requested" or "Review in progress".
 * The host writes the last two only when GitHub shows something else, so a
 * second pass writes nothing. Then it re-reads the context on every head and
 * reports coverage: a head still without it is listed and counted as an error
 * of the floor run, and a pass that read no head is `nothing_checked`, never
 * covered.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { LANDING_STATUS_CONTEXT, LANDING_STATUS_CONTEXTS, type LandingStatus } from '@buildd/workflow-kernel/landing-gate';
import { openHeadStatus, statusCoverage, type CandidateGateInput, type OpenHeadAnswer, type OpenHead, type StatusCoverage, type UnownedReview } from '@buildd/workflow-kernel/open-pr-status';
import type { KernelView } from '@buildd/workflow-kernel/types';
import { githubApi } from '@/lib/github';
import { kernelDeliveryForPr } from './authority';
import { enqueueEffectSql } from './enqueue-missing';
import { githubReader } from './github-facts';
import { loadView as loadKernelView, type Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** A workspace's linked repo, with what classifying a release candidate needs. */
export interface LinkedRepo {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  releaseConfig: WorkspaceReleaseConfig | null;
}

/** An open PR as GitHub's list returns it (the fields read here). */
export interface OpenPull {
  number: number;
  draft?: boolean;
  body?: string | null;
  user?: { login?: string | null } | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
}

/** The review reads of an open PR the kernel does not answer for (the releases module's, through the composition root). */
export interface OpenPrReviews {
  /** Whether the PR is a frozen release candidate under this workspace's release config (`classifyReleasePr`). */
  isCandidate(releaseConfig: WorkspaceReleaseConfig | null, pr: ReleasePrFacts): boolean;
  review(p: { workspaceId: string; prNumber: number }): Promise<UnownedReview>;
  candidate(p: { workspaceId: string; installationId: number; repoFullName: string; prNumber: number; sha: string }): Promise<Omit<CandidateGateInput, 'sha'>>;
}

/** The PR facts a release candidate is classified on (packages/core/release-candidate.ts `ReleasePrFacts`). */
export interface ReleasePrFacts {
  headRef?: string | null; baseRef?: string | null; headSha?: string | null; author?: string | null;
  headRepoFullName?: string | null; baseRepoFullName?: string | null; body?: string | null;
}

type Shown = { state: string; description: string } | null;

export interface OpenPrStatusDeps {
  exec?: Exec;
  repos?: () => Promise<LinkedRepo[]>;
  listOpenPulls?: (installationId: number, repoFullName: string) => Promise<OpenPull[]>;
  statusOf?: (installationId: number, repoFullName: string, sha: string, context: string) => Promise<Shown>;
  publish?: (installationId: number, p: { repoFullName: string; sha: string; context: string; state: LandingStatus['state']; description: string }) => Promise<void>;
  owned?: (workspaceId: string, repoFullName: string, prNumber: number) => Promise<string | null>;
  loadView?: (deliveryId: string) => Promise<KernelView>;
  /** Insert the republish effect at `version`; false when it is already held (same version). */
  enqueueRepublish?: (deliveryId: string, version: number) => Promise<boolean>;
  drain?: (deliveryId: string) => Promise<unknown>;
  reviews?: () => Promise<OpenPrReviews>;
}

export interface OpenPrStatusSummary {
  repos: number;
  /** Open heads read. */
  checked: number;
  /** Heads the host wrote (a PR no delivery answers for, or a release candidate). */
  published: number;
  /** Kernel-owned heads whose republish effect was enqueued. */
  republished: number;
  /** Heads already showing their answer. */
  unchanged: number;
  candidates: number;
  errors: number;
  coverage: StatusCoverage;
}

/** Linked repos: a workspace with a GitHub repo on an installation that is not suspended. */
export function linkedReposSql() {
  return sql`-- workflow:open_pr_status_repos
SELECT w.id AS workspace_id, gi.installation_id, gr.full_name AS repo_full_name, w.release_config
FROM workspaces w
JOIN github_repos gr ON gr.id = w.github_repo_id
JOIN github_installations gi ON gi.id = gr.installation_id
WHERE gi.suspended_at IS NULL
ORDER BY gr.full_name, w.created_at, w.id`;
}

export async function linkedRepos(exec: Exec = dbExec): Promise<LinkedRepo[]> {
  const rows = ((await exec(linkedReposSql())).rows ?? []) as Array<{ workspace_id: string; installation_id: number | string; repo_full_name: string; release_config: unknown }>;
  return rows.map((r) => ({
    workspaceId: String(r.workspace_id), installationId: Number(r.installation_id), repoFullName: String(r.repo_full_name),
    releaseConfig: (r.release_config ?? null) as WorkspaceReleaseConfig | null,
  }));
}

/** Pages of open PRs read per repo (100 each). A repo with more is read on its first 300. */
const MAX_PAGES = 3;

async function listOpenPullsLive(installationId: number, repoFullName: string): Promise<OpenPull[]> {
  const out: OpenPull[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = (await githubApi(installationId, `/repos/${repoFullName}/pulls?state=open&per_page=100&page=${page}`)) as OpenPull[] | null;
    if (!Array.isArray(raw)) throw new Error(`could not list the open PRs of ${repoFullName}`);
    out.push(...raw);
    if (raw.length < 100) break;
  }
  return out;
}

async function publishLive(installationId: number, p: { repoFullName: string; sha: string; context: string; state: LandingStatus['state']; description: string }): Promise<void> {
  // The kernel's `GithubWrites.publishStatus` (kernel-ports.ts), with no link: a PR no delivery owns has no task page.
  await githubApi(installationId, `/repos/${p.repoFullName}/statuses/${p.sha}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: p.state, context: p.context, description: p.description.slice(0, 140) }),
  });
}

/** The republish effect's key: one per delivery version, so a pass repeats nothing the outbox holds. */
export const republishKey = (deliveryId: string, version: number) => `landing_status:${deliveryId}:${version}:open-pr-sweep`;

interface HeadRun {
  deps: OpenPrStatusDeps;
  exec: Exec;
  reviews: OpenPrReviews;
  /** False on the web host's webhook path: a kernel write (an effect and its drain) is the control plane's, so only the floor does it. */
  kernelRepublish: boolean;
}

type HeadResult = { shown: boolean; by: OpenHeadAnswer['by'] | null; wrote: boolean; republished: boolean; unchanged: boolean };

/** Write `answer` on one open head (the sweep's and the webhooks' shared step): what GitHub shows now is compared first, so a repeat writes nothing. */
async function publishHead(run: HeadRun, links: LinkedRepo[], pr: OpenPull, sha: string): Promise<HeadResult> {
  const { deps, exec, reviews } = run;
  const { installationId, repoFullName } = links[0]!;
  const statusOf = deps.statusOf ?? ((i, r, h, c) => githubReader(i).statusOf!(r, h, c));
  const publish = deps.publish ?? publishLive;
  const owned = deps.owned ?? ((w, r, n) => kernelDeliveryForPr(w, r, n, exec));
  const loadView = deps.loadView ?? ((id) => loadKernelView({ deliveryId: id }, exec));
  const enqueueRepublish = deps.enqueueRepublish ?? (async (id, version) =>
    ((await exec(enqueueEffectSql(id, version, { kind: 'publish_landing_status', dedupeKey: republishKey(id, version), payload: { version } }))).rows ?? []).length > 0);
  const drain = deps.drain ?? (async (id) => (await import('./seam')).drainDelivery(id));

  const out: HeadResult = { shown: false, by: null, wrote: false, republished: false, unchanged: false };
  const read = () => Promise.all(LANDING_STATUS_CONTEXTS.map((c) => statusOf(installationId, repoFullName, sha, c).catch(() => null)));
  const matches = (cur: Shown[], want: LandingStatus) => cur.every((x) => x && x.state === want.state && x.description === want.description);
  const ownerOf = async () => {
    for (const l of links) {
      const id = await owned(l.workspaceId, repoFullName, pr.number);
      if (id) return { link: l, deliveryId: id };
    }
    return null;
  };
  const republish = async (deliveryId: string, view: KernelView) => {
    const inserted = await enqueueRepublish(deliveryId, view.delivery!.version);
    if (inserted) out.republished = true;
    await drain(deliveryId);
  };

  const owner = await ownerOf();
  const view = owner ? await loadView(owner.deliveryId) : null;
  const link = owner?.link ?? links[0]!;
  const facts = {
    headRef: pr.head?.ref, baseRef: pr.base?.ref, headSha: sha, author: pr.user?.login ?? null,
    headRepoFullName: pr.head?.repo?.full_name ?? null, baseRepoFullName: pr.base?.repo?.full_name ?? repoFullName, body: pr.body ?? null,
  };
  const candidateLink = links.find((l) => reviews.isCandidate(l.releaseConfig, facts)) ?? null;
  const workspaceId = candidateLink?.workspaceId ?? link.workspaceId;
  // Only what the answer needs: the kernel's own answer reads no review state.
  const kernelHere = openHeadStatus({ sha, view });
  const answer = kernelHere.by === 'kernel' ? kernelHere : openHeadStatus({
    sha, view,
    candidate: candidateLink ? await reviews.candidate({ workspaceId, installationId, repoFullName, prNumber: pr.number, sha }) : null,
    review: candidateLink ? undefined : await reviews.review({ workspaceId, prNumber: pr.number }),
  });
  out.by = answer.by;
  const current = await read();
  if (matches(current, answer.status)) {
    out.shown = true;
    out.unchanged = true;
  } else if (answer.by === 'kernel') {
    if (run.kernelRepublish) {
      await republish(owner!.deliveryId, view!);
      out.shown = !!(await statusOf(installationId, repoFullName, sha, LANDING_STATUS_CONTEXT).catch(() => null));
    } else {
      out.shown = current.some((x) => x);
    }
  } else {
    // Under both names, the legacy one first, as the kernel writes them.
    for (const context of LANDING_STATUS_CONTEXTS) {
      await publish(installationId, { repoFullName, sha, context, state: answer.status.state, description: answer.status.description });
    }
    out.wrote = true;
    out.shown = true;
    if (run.kernelRepublish) {
      // A delivery that took the PR (or saw this head) while this pass wrote: its answer is the last write.
      const now = await ownerOf();
      if (now) {
        const v = await loadView(now.deliveryId);
        if (openHeadStatus({ sha, view: v }).by === 'kernel') await republish(now.deliveryId, v);
      }
    }
  }
  return out;
}

export async function publishOpenPrStatuses(deps: OpenPrStatusDeps = {}): Promise<OpenPrStatusSummary> {
  const exec = deps.exec ?? dbExec;
  const reviews = await (deps.reviews ?? (async () => (await import('@/modules')).openPrReviewReads()))();
  const run: HeadRun = { deps, exec, reviews, kernelRepublish: true };

  const s: Omit<OpenPrStatusSummary, 'coverage'> = { repos: 0, checked: 0, published: 0, republished: 0, unchanged: 0, candidates: 0, errors: 0 };
  const heads: Array<OpenHead & { shown: boolean }> = [];

  // One pass per repo; a repo linked from several workspaces is read once, and owned by whichever workspace has the delivery.
  const byRepo = new Map<string, LinkedRepo[]>();
  for (const r of await (deps.repos ?? (() => linkedRepos(exec)))()) {
    const k = r.repoFullName.toLowerCase();
    byRepo.set(k, [...(byRepo.get(k) ?? []), r]);
  }

  for (const links of byRepo.values()) {
    const { installationId, repoFullName } = links[0]!;
    s.repos++;
    let pulls: OpenPull[];
    try {
      pulls = await (deps.listOpenPulls ?? listOpenPullsLive)(installationId, repoFullName);
    } catch (err) {
      s.errors++;
      console.error(`[workflow] open PR status: listing ${repoFullName} failed:`, err);
      continue;
    }
    for (const pr of pulls) {
      const sha = pr.head?.sha;
      if (!sha) continue;
      s.checked++;
      const head: OpenHead = { repoFullName, prNumber: pr.number, sha };
      let shown = false;
      try {
        const r = await publishHead(run, links, pr, sha);
        shown = r.shown;
        if (r.by === 'release_candidate') s.candidates++;
        if (r.republished) s.republished++;
        if (r.wrote) s.published++;
        else if (r.unchanged) s.unchanged++;
      } catch (err) {
        s.errors++;
        console.error(`[workflow] open PR status for ${repoFullName}#${pr.number} failed:`, err);
      }
      heads.push({ ...head, shown });
    }
  }
  return { ...s, coverage: statusCoverage(heads) };
}

export type PrEventOutcome = 'published' | 'unchanged' | 'skipped_not_open' | 'skipped_stale_head' | 'skipped_unlinked';

/** The PR as GitHub shows it now (null: gone). */
async function getPullLive(installationId: number, repoFullName: string, prNumber: number): Promise<OpenPull & { state?: string } | null> {
  const raw = (await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`)) as (OpenPull & { state?: string }) | null;
  return raw && typeof raw === 'object' && 'number' in raw ? raw : null;
}

/** Most times one event re-derives its answer after writing, to follow inputs that moved under it. */
const MAX_SETTLE = 3;

/**
 * An event (a PR opened or pushed, a check finished, a review verdict recorded) re-derives one open
 * head's `Buildd / Review approval` now instead of at the next hourly floor (AC-40, AC-42).
 *
 * Ordered by construction, never by the event's arrival: the answer is derived from what GitHub and
 * the review state show *now*, not from the payload, so a late or duplicate event repeats the newest
 * answer. A PR no longer open, or whose head is not the event's `sha`, is skipped, so an older head's
 * event never writes. After writing, the answer is derived again and rewritten if its inputs moved
 * meanwhile (a concurrent newer event's write is never left overwritten by an older one's).
 * Writes only when GitHub shows something else, so a duplicate writes nothing.
 *
 * Runs on the web host: it writes commit statuses only. A head a delivery owns is the kernel's to
 * publish (through the door), so this never enqueues or drains kernel effects; the floor does.
 */
export async function publishOpenPrHead(
  p: { installationId: number; repoFullName: string; prNumber: number; sha?: string | null },
  deps: OpenPrStatusDeps & { getPull?: (installationId: number, repoFullName: string, prNumber: number) => Promise<(OpenPull & { state?: string }) | null> } = {},
): Promise<PrEventOutcome> {
  const exec = deps.exec ?? dbExec;
  const reviews = await (deps.reviews ?? (async () => (await import('@/modules')).openPrReviewReads()))();
  const links = (await (deps.repos ?? (() => linkedRepos(exec)))()).filter((r) => r.repoFullName.toLowerCase() === p.repoFullName.toLowerCase());
  if (!links.length) return 'skipped_unlinked';
  const linked = [{ ...links[0]!, installationId: p.installationId }, ...links.slice(1)];
  const getPull = deps.getPull ?? getPullLive;
  const run: HeadRun = { deps, exec, reviews, kernelRepublish: false };

  let outcome: PrEventOutcome = 'unchanged';
  for (let i = 0; i < MAX_SETTLE; i++) {
    const pr = await getPull(p.installationId, links[0]!.repoFullName, p.prNumber);
    if (!pr || (pr.state && pr.state !== 'open')) return i === 0 ? 'skipped_not_open' : outcome;
    const sha = pr.head?.sha;
    if (!sha || (p.sha && p.sha !== sha && i === 0)) return i === 0 ? 'skipped_stale_head' : outcome;
    const r = await publishHead(run, linked, pr, sha);
    if (!r.wrote) return outcome;
    outcome = 'published';
    // It wrote: derive again, so inputs that moved while it wrote are not left behind.
  }
  return outcome;
}
