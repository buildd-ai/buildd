/**
 * One landing authority at every merge door
 * (docs/specs/workflow-state-kernel.md §13.13 rule 6, door inventory D1 to D11).
 *
 * `landingAuthority` answers one question before any `PUT .../merge`: does the
 * PR's delivery hold an open finding, or an unresolved request-changes or
 * escalation of the review? `mergeWithAuthority` asks it and only then calls
 * `mergePullRequest`, so a door cannot forget. A refusal is a `review_verdict`
 * gate row naming the door, and the result a door can show (`message`).
 *
 * It reads the delivery whatever its authority: a delivery released to legacy
 * keeps its findings, and a finding is not the kernel's alone to forget. A PR
 * with no delivery (a release PR, an integration PR before one is opened) has
 * nothing to ask here; the legacy verdict gate still stands for it. The read
 * fails closed: an unreadable ledger refuses the merge, as the verdict gate does.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { mergePullRequest, type MergePullRequestResult } from '@/lib/github';
import { describeFinding, openFindings } from './findings';
import { loadView, type Exec } from './kernel';
import type { KernelView } from './types';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** The merge doors of the §13.13 inventory, as the string a refusal row records. */
export type MergeDoor =
  | 'kernel_merge_call' | 'land_pr' | 'landing_sweep' | 'auto_merge' | 'merge_pr_mcp' | 'dashboard_merge'
  | 'release_pr_ci' | 'release_executor_pr' | 'release_executor_prod' | 'compose_release' | 'policy_rule_merge';

export type LandingAuthority =
  | { blocks: false }
  | { blocks: true; kind: 'open_findings' | 'review_unresolved' | 'unreadable'; reason: string; findings: string[] };

const REVIEW_ESCALATIONS = new Set(['review_escalated', 'review_exhausted', 'review_unavailable']);

/** The pure rule over one delivery's view. */
export function judgeLanding(view: Pick<KernelView, 'delivery' | 'findings'>): LandingAuthority {
  const open = openFindings(view.findings);
  if (open.length) {
    return {
      blocks: true, kind: 'open_findings', findings: open.map(describeFinding),
      reason: `${open.length} review finding${open.length === 1 ? ' is' : 's are'} still open: ${open.slice(0, 3).map(describeFinding).join('; ')}`,
    };
  }
  const d = view.delivery;
  if (d && (d.state === 'CHANGES_REQUESTED' || d.state === 'FIXING' || (d.state === 'ESCALATED' && REVIEW_ESCALATIONS.has(d.stateReason ?? '')))) {
    return { blocks: true, kind: 'review_unresolved', findings: [], reason: `the review of this PR is unresolved (${d.state}${d.stateReason ? `: ${d.stateReason}` : ''})` };
  }
  return { blocks: false };
}

export interface LandingAuthorityDeps {
  /** The delivery view for a PR, or null when it has none. */
  viewForPr?: (p: { repoFullName: string; prNumber: number; workspaceId?: string | null }) => Promise<Pick<KernelView, 'delivery' | 'findings'> | null>;
}

async function viewForPr(p: { repoFullName: string; prNumber: number; workspaceId?: string | null }): Promise<Pick<KernelView, 'delivery' | 'findings'> | null> {
  const rows = ((await dbExec(sql`-- workflow:landing_authority_delivery
SELECT id FROM workflow_deliveries
WHERE repo_full_name = ${p.repoFullName}::text AND pr_number = ${p.prNumber}::int
  ${p.workspaceId ? sql`AND workspace_id = ${p.workspaceId}::uuid` : sql``}
ORDER BY created_at DESC LIMIT 1`)).rows ?? []) as Array<{ id: string }>;
  if (!rows[0]) return null;
  return loadView({ deliveryId: rows[0].id }, dbExec);
}

export async function landingAuthority(
  p: { repoFullName: string; prNumber: number; workspaceId?: string | null; door: MergeDoor; headSha?: string | null },
  deps: LandingAuthorityDeps = {},
): Promise<LandingAuthority> {
  let verdict: LandingAuthority;
  try {
    const view = await (deps.viewForPr ?? viewForPr)(p);
    verdict = view ? judgeLanding(view) : { blocks: false };
  } catch (err) {
    verdict = { blocks: true, kind: 'unreadable', findings: [], reason: `could not read this PR's review findings, so the merge was refused: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (verdict.blocks) {
    fireGateEvent({
      gate: GATE_SLUGS.REVIEW_VERDICT,
      surface: p.door,
      outcome: 'rejected',
      reason: verdict.reason,
      workspaceId: p.workspaceId ?? null,
      callerOrigin: 'system',
      detail: { door: p.door, prNumber: p.prNumber, repoFullName: p.repoFullName, headSha: p.headSha ?? null, kind: verdict.kind, findings: verdict.findings },
    });
  }
  return verdict;
}

export type GuardedMergeResult = MergePullRequestResult & { refusedByLandingAuthority?: Extract<LandingAuthority, { blocks: true }> };

/** The one way a door calls the REST merge: the authority first, GitHub only if it passes. */
export async function mergeWithAuthority(
  p: {
    door: MergeDoor; installationId: number; repoFullName: string; prNumber: number;
    method: 'merge' | 'squash' | 'rebase'; headSha: string; workspaceId?: string | null;
    /** A person's recorded override of the verdict (the dashboard's "Merge anyway"): recorded, never silent. */
    override?: { actor: string; reason: string } | null;
  },
  deps: LandingAuthorityDeps & { merge?: typeof mergePullRequest } = {},
): Promise<GuardedMergeResult> {
  const authority = await landingAuthority({ repoFullName: p.repoFullName, prNumber: p.prNumber, workspaceId: p.workspaceId, door: p.door, headSha: p.headSha }, deps);
  if (authority.blocks) {
    if (p.override?.actor.startsWith('human:') && p.override.reason.trim() && authority.kind !== 'unreadable') {
      fireGateEvent({
        gate: GATE_SLUGS.REVIEW_VERDICT, surface: p.door, outcome: 'bypassed', reason: `person override: ${p.override.reason.trim()}`,
        workspaceId: p.workspaceId ?? null, callerOrigin: 'dashboard',
        detail: { door: p.door, prNumber: p.prNumber, actor: p.override.actor, findings: authority.findings, headSha: p.headSha },
      });
    } else {
      return { merged: false, status: 409, message: `Merge refused: ${authority.reason}`, refusedByLandingAuthority: authority };
    }
  }
  return (deps.merge ?? mergePullRequest)(p.installationId, p.repoFullName, p.prNumber, p.method, p.headSha);
}
