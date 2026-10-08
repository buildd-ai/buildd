/**
 * The `ingestFact` funnel (docs/specs/workflow-state-kernel.md §2, §5.3, §11):
 * record an observation once under its natural key, then run exactly one
 * reducer pass over it. A fact never assigns state by itself; the transition
 * it maps to does, and only if the transition table allows it.
 *
 * Fact kinds: `delivery_opened`, `pr_bound`, `head_observed`, `pr_closed`
 * (merged or closed unmerged, decided by the live read), plus
 * `composition_attested` (evidence that a composed PR's head is built from
 * already-reviewed changes). R2: for PR facts the kernel takes its own GitHub
 * read after the hint arrived and acts on that, never on the hint's payload.
 *
 * Routes reach this through seam.ts.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Command, LivePr } from './commands';
import { applyCommand, loadView, type CommandResult, type DeliveryRef, type Exec } from './kernel';
import { headCoverage, headObservationKey } from './reducer';
import type { CloseCause, CompositionAttestation, ConstituentEvidence, DeliverySnapshot, KernelView } from './types';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export interface GithubFactReader {
  /** Live `GET /repos/{repo}/pulls/{n}`; null when it cannot be read. */
  readPr(repoFullName: string, prNumber: number): Promise<LivePr | null>;
  /** Compare API: is `ancestorSha` contained in `headSha`? */
  contains?(repoFullName: string, ancestorSha: string, headSha: string): Promise<boolean>;
  /**
   * Is CI green on `headSha` now (every check suite completed, none failing)?
   * null = unknown (still running, no suites, unreadable): never read as green.
   */
  ciGreen?(repoFullName: string, headSha: string): Promise<boolean | null>;
  /**
   * The check runs on `sha` (§6.10 signatures): the names of the failing ones,
   * and whether every run has completed. null = unreadable.
   */
  checkRuns?(repoFullName: string, sha: string): Promise<{ complete: boolean; failing: string[] } | null>;
  /** The head commit of branch `ref` now; null = unreadable. */
  branchHead?(repoFullName: string, ref: string): Promise<string | null>;
  /**
   * Names of the checks and workflows that failed on `headSha` (§6.10: a CI
   * failure a preflight would have caught is tagged `preflight_miss`).
   * null = unreadable; never read as "nothing failed".
   */
  failingChecks?(repoFullName: string, headSha: string): Promise<string[] | null>;
  /**
   * §8.3 content-equivalence: does the PR carry the same change at `toSha` as
   * at `fromSha`, each compared against `baseRef`? null = could not tell;
   * never read as equivalent.
   */
  contentEquivalent?(repoFullName: string, baseRef: string, fromSha: string, toSha: string): Promise<boolean | null>;
  /**
   * Does branch `ref` exist in `repoFullName` now? A PR GitHub closed because
   * its base branch was deleted is `CLOSED_UNMERGED(base_deleted)` (§4).
   * null = unreadable; never read as "deleted".
   */
  branchExists?(repoFullName: string, ref: string): Promise<boolean | null>;
}

export type FactInput =
  | { kind: 'delivery_opened'; workspaceId: string; source: string; ownerTaskId: string; requiresPr: boolean; maxRounds?: number }
  | {
      kind: 'pr_bound';
      workspaceId: string;
      source: string;
      repoFullName: string;
      prNumber: number;
      /** The delivery's owner task; omit together with `adoption` for a PR buildd did not open. */
      ownerTaskId: string;
      adoption?: boolean;
    }
  | {
      kind: 'head_observed'; workspaceId: string; source: string; repoFullName: string; prNumber: number; hintedHeadSha?: string | null;
    }
  | { kind: 'pr_closed'; workspaceId: string; source: string; repoFullName: string; prNumber: number }
  | { kind: 'composition_attested'; workspaceId: string; source: string; attestation: CompositionAttestation };

export type FactKind = FactInput['kind'];

export type IngestResult =
  | ({ factId: string; factKey: string; firstSeen: boolean } & CommandResult)
  | { factId: null; factKey: null; firstSeen: false; result: 'rejected'; reason: 'live_read_failed'; current: null };

/** Bounded, normalised payload: the fields the reducer read, never a raw webhook body. */
export function insertFactSql(f: {
  workspaceId: string; kind: FactKind; factKey: string; source: string;
  repoFullName?: string | null; prNumber?: number | null; payload: Record<string, unknown>;
}): SQL {
  return sql`-- workflow:insert_fact
INSERT INTO workflow_facts (workspace_id, repo_full_name, pr_number, kind, fact_key, source, payload)
VALUES (${f.workspaceId}::uuid, ${f.repoFullName ?? null}::text, ${f.prNumber ?? null}::int, ${f.kind}::text, ${f.factKey}::text, ${f.source}::text, ${JSON.stringify(f.payload)}::jsonb)
ON CONFLICT (workspace_id, fact_key) DO NOTHING
RETURNING id`;
}

/**
 * The head fact whose application installed the delivery's current head: the
 * newest applied HeadObserved. A redelivery of that move reads it after it
 * landed, so it is answered with this fact rather than recorded again (§5.3).
 */
export function lastAppliedHeadFactSql(workspaceId: string, deliveryId: string): SQL {
  return sql`-- workflow:last_head_fact
SELECT f.id, f.fact_key, f.applied_transition_id FROM workflow_facts f
JOIN workflow_transitions t ON t.id = f.applied_transition_id
WHERE f.workspace_id = ${workspaceId}::uuid AND t.delivery_id = ${deliveryId}::uuid AND t.command = 'HeadObserved'
ORDER BY t.to_version DESC
LIMIT 1`;
}

export function findFactSql(workspaceId: string, factKey: string): SQL {
  return sql`-- workflow:find_fact
SELECT id, applied_transition_id FROM workflow_facts
WHERE workspace_id = ${workspaceId}::uuid AND fact_key = ${factKey}::text
LIMIT 1`;
}

/**
 * What a composition attestation's constituents actually are in the ledger:
 * each round's own head, status and verdict, and its delivery's approved
 * heads (verdict + recorded equivalents — never composition heads).
 */
export function constituentEvidenceSql(workspaceId: string, roundIds: string[]): SQL {
  return sql`-- workflow:constituent_evidence
SELECT r.id AS round_id, r.head_sha, r.status, r.effective_verdict, d.approved_heads,
  d.id AS delivery_id, d.pr_number, d.repo_full_name
FROM workflow_review_rounds r
JOIN workflow_deliveries d ON d.id = r.delivery_id
WHERE d.workspace_id = ${workspaceId}::uuid
  AND r.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(roundIds)}::jsonb))::uuid)`;
}

/**
 * The natural key of a fact (§2 table). PR keys use the LIVE head. A head
 * observation is keyed on the move it records (§6.3 T3): the head the delivery
 * `held` and its version when the fact was read, so A→B→A is three facts.
 */
export function factKeyFor(f: FactInput, live?: LivePr | null, held?: { headSha: string | null; version: number } | null): string {
  switch (f.kind) {
    case 'delivery_opened': return `open:${f.ownerTaskId}`;
    case 'pr_bound': return `bind:${f.repoFullName}#${f.prNumber}`;
    case 'head_observed':
      return headObservationKey(`${f.repoFullName}#${f.prNumber}`, held?.headSha ?? null, live?.headSha ?? 'unknown', held?.version ?? 0);
    case 'pr_closed':
      // The live read decides what this is: merged, closed unmerged, or reopened since.
      return live?.merged ? `merged:${f.repoFullName}#${f.prNumber}`
        : live?.state === 'open' ? `reopen:${f.repoFullName}#${f.prNumber}:${live?.updatedAt ?? 'unknown'}`
          : `closed:${f.repoFullName}#${f.prNumber}:${live?.updatedAt ?? 'unknown'}`;
    case 'composition_attested': return `compose:${f.attestation.repoFullName}#${f.attestation.prNumber}:${f.attestation.aggregateHeadSha}`;
  }
}

export interface IngestDeps {
  exec?: Exec;
  github?: GithubFactReader;
  newId?: () => string;
}

/**
 * Record `fact` (idempotent on its key) and apply the command it maps to.
 * A duplicate whose first application never committed (crash between the
 * two statements) is applied again — the transition's own idempotency key
 * keeps that safe.
 */
export async function ingestFact(fact: FactInput, deps: IngestDeps = {}): Promise<IngestResult> {
  const exec = deps.exec ?? dbExec;
  let live: LivePr | null = null;
  if (fact.kind === 'pr_bound' || fact.kind === 'head_observed' || fact.kind === 'pr_closed') {
    if (!deps.github) throw new Error(`ingestFact(${fact.kind}): a GitHub reader is required (R2: act on a live read)`);
    live = await deps.github.readPr(fact.repoFullName, fact.prNumber);
    if (!live) return { factId: null, factKey: null, firstSeen: false, result: 'rejected', reason: 'live_read_failed', current: null };
  }

  const { command, ref, payload, repoFullName, prNumber, held } = await commandFor(fact, live, exec, deps.github);
  const factKey = factKeyFor(fact, live, held);

  if (fact.kind === 'head_observed' && held?.deliveryId && live && held.headSha === live.headSha) {
    // Read after the move it reports landed: the same fact as that move, not a new one.
    const last = ((await exec(lastAppliedHeadFactSql(fact.workspaceId, held.deliveryId))).rows ?? [])[0] as
      { id: string; fact_key: string; applied_transition_id: string } | undefined;
    if (last && last.fact_key.includes(`->${live.headSha}@v`)) {
      return {
        factId: last.id, factKey: last.fact_key, firstSeen: false, result: 'duplicate', transitionId: last.applied_transition_id, reason: 'fact_seen',
        current: { state: held.state, version: held.version, head: held.headSha, round: held.round },
      };
    }
  }

  const inserted = ((await exec(insertFactSql({ workspaceId: fact.workspaceId, kind: fact.kind, factKey, source: fact.source, repoFullName, prNumber, payload }))).rows ?? [])[0] as { id: string } | undefined;
  let factId: string;
  let firstSeen = true;
  if (!inserted) {
    firstSeen = false;
    const prior = ((await exec(findFactSql(fact.workspaceId, factKey))).rows ?? [])[0] as { id: string; applied_transition_id: string | null } | undefined;
    if (!prior) throw new Error(`ingestFact: fact ${factKey} neither inserted nor found`);
    factId = prior.id;
    if (prior.applied_transition_id) {
      const view = await loadView(ref, exec).catch(() => null);
      const d = view?.delivery;
      return {
        factId, factKey, firstSeen, result: 'duplicate', transitionId: prior.applied_transition_id, reason: 'fact_seen',
        current: { state: d?.state ?? null, version: d?.version ?? 0, head: d?.currentHeadSha ?? null, round: d?.currentRound ?? 0 },
      };
    }
  } else {
    factId = inserted.id;
  }

  const cmd: Command = command.type === 'CompositionAttested' ? { ...command, factId } : command;
  const result = await applyCommand(cmd, { ref, factId, exec, newId: deps.newId });
  if (result.result === 'applied' && command.type === 'HeadObserved' && result.decision.toState === 'APPROVED' && result.decision.evidence.carryForward) {
    // §8.3: the legacy merge gate's `equivalentHeadShas` is a projection of the
    // committed T13, written after it and never ahead of it.
    await exec(projectEquivalentHeadSql(result.deliveryId, String(result.decision.evidence.previousHead ?? ''), command.live.headSha))
      .catch((err) => console.warn(`[workflow] equivalentHeadShas projection failed for ${result.deliveryId}:`, err));
  }
  return { factId, factKey, firstSeen, ...result };
}

/**
 * §8.3 / T13 evidence for a head that moved under an approval, decided from
 * the delivery itself: the previous head must be one the delivery's approval
 * covers (`approved_heads` or `composition_heads`, whatever the basis), and
 * the PR's diff must be unchanged between it and the live head. When the
 * previous head is also the one the platform's own `refresh_branch` effect was
 * pinned to, the evidence is `own_refresh`. Never the newest reviewer row: a
 * row at another head says nothing about this delivery's approval.
 */
export async function carryForwardEvidence(
  view: KernelView, repoFullName: string, live: LivePr, exec: Exec, github?: GithubFactReader,
): Promise<'content_equivalent' | 'own_refresh' | null> {
  const d = view.delivery;
  if (!d || !d.currentHeadSha || live.headSha === d.currentHeadSha) return null;
  if (d.state !== 'APPROVED' && d.state !== 'LANDING' && d.state !== 'REPAIRING') return null;
  // A policy approval is not a review; the reducer keeps it on any head without evidence.
  if (d.approvalBasis === 'policy') return null;
  const previous = d.currentHeadSha;
  if (headCoverage(d as DeliverySnapshot, previous) === 'none') return null;
  if (!live.baseRef || !github?.contentEquivalent) return null;
  const same = await github.contentEquivalent(repoFullName, live.baseRef, previous, live.headSha).catch(() => null);
  if (same !== true) return null;
  const own = ((await exec(ownRefreshSql(d.id, previous))).rows ?? []).length > 0;
  return own ? 'own_refresh' : 'content_equivalent';
}

/** A `refresh_branch` effect of this delivery, pinned to `headSha`, that updated (or is updating) the branch. */
export function ownRefreshSql(deliveryId: string, headSha: string): SQL {
  return sql`-- workflow:own_refresh
SELECT 1 FROM workflow_effects
WHERE delivery_id = ${deliveryId}::uuid AND kind = 'refresh_branch'
  AND payload->>'headSha' = ${headSha}::text
  AND (outcome = 'ok:updated' OR (status = 'delivering' AND outcome IS NULL))
LIMIT 1`;
}

/**
 * Append `headSha` to `equivalentHeadShas` on the reviewer task of the round
 * whose approval covered `previousHead` (the latest decided approve at it), once.
 * A composition or human approval has no such round: nothing is projected.
 */
export function projectEquivalentHeadSql(deliveryId: string, previousHead: string, headSha: string): SQL {
  return sql`-- workflow:project_equivalent_head
WITH src AS (
  SELECT r.reviewer_task_id AS id FROM workflow_review_rounds r
  JOIN tasks rt ON rt.id = r.reviewer_task_id
  WHERE r.delivery_id = ${deliveryId}::uuid AND r.reviewer_task_id IS NOT NULL
    AND r.effective_verdict = 'approve'
    AND (r.head_sha = ${previousHead}::text OR COALESCE(rt.context->'equivalentHeadShas', '[]'::jsonb) @> jsonb_build_array(${previousHead}::text))
  ORDER BY r.round DESC LIMIT 1
)
UPDATE tasks t
SET context = jsonb_set(COALESCE(t.context, '{}'::jsonb), '{equivalentHeadShas}',
      COALESCE(t.context->'equivalentHeadShas', '[]'::jsonb) || to_jsonb(${headSha}::text)),
    updated_at = now()
FROM src
WHERE t.id = src.id AND NOT (COALESCE(t.context->'equivalentHeadShas', '[]'::jsonb) @> jsonb_build_array(${headSha}::text))`;
}

async function commandFor(fact: FactInput, live: LivePr | null, exec: Exec, github?: GithubFactReader): Promise<{
  command: Command; ref: DeliveryRef; payload: Record<string, unknown>; repoFullName: string | null; prNumber: number | null;
  /** What the delivery held when the fact was read (head facts only). */
  held?: { deliveryId: string; headSha: string | null; version: number; state: DeliverySnapshot['state']; round: number } | null;
}> {
  const actor = fact.source;
  switch (fact.kind) {
    case 'delivery_opened':
      return {
        command: { type: 'DeliveryOpened', actor, workspaceId: fact.workspaceId, ownerTaskId: fact.ownerTaskId, requiresPr: fact.requiresPr, maxRounds: fact.maxRounds },
        ref: { workspaceId: fact.workspaceId, ownerTaskId: fact.ownerTaskId },
        payload: { ownerTaskId: fact.ownerTaskId, requiresPr: fact.requiresPr },
        repoFullName: null, prNumber: null,
      };
    case 'pr_bound':
      return {
        command: {
          type: 'PrBound', actor, repoFullName: fact.repoFullName, prNumber: fact.prNumber, live: live!,
          ...(fact.adoption ? { adoption: { workspaceId: fact.workspaceId, ownerTaskId: fact.ownerTaskId } } : {}),
        },
        ref: { workspaceId: fact.workspaceId, ownerTaskId: fact.ownerTaskId },
        payload: { ownerTaskId: fact.ownerTaskId, adoption: !!fact.adoption, live },
        repoFullName: fact.repoFullName, prNumber: fact.prNumber,
      };
    case 'head_observed': {
      const ref: DeliveryRef = { workspaceId: fact.workspaceId, repoFullName: fact.repoFullName, prNumber: fact.prNumber };
      // §9 proof input: does the live head contain the bound attempt's reported local head?
      let proof: { liveContainsLocal: boolean; contentDiffChanged?: boolean } | undefined;
      const view = await loadView(ref, exec);
      const bound = view.attempts.find((a) => a.id === view.delivery?.boundAttemptId);
      const awaitingPush = view.delivery?.state === 'AWAITING_PUSH'
        || (view.delivery?.state === 'ESCALATED' && view.delivery.stateReason === 'push_undeliverable');
      // An owner in AWAITING_PUSH has no ledger row: its L is the delivery's pending local head.
      const local = bound?.reportedShas.at(-1) ?? (awaitingPush ? view.delivery?.pushPendingLocalHead ?? undefined : undefined);
      if (local && live && local !== live.headSha && github?.contains) {
        proof = { liveContainsLocal: await github.contains(fact.repoFullName, local, live.headSha) };
      } else if (!local && awaitingPush && live && view.delivery?.currentHeadSha && live.headSha !== view.delivery.currentHeadSha && github?.contains) {
        // §9 with L unknown (the runner died before reporting): the remote moved off
        // Hb and the PR's content changed, read as "the new head descends from Hb".
        proof = { liveContainsLocal: false, contentDiffChanged: await github.contains(fact.repoFullName, view.delivery.currentHeadSha, live.headSha) };
      }
      // §6.9 provenance input: does the live head descend from the bound attempt's head?
      let attribution: { descendsFromBound: boolean } | undefined;
      if (bound?.boundHeadSha && live && bound.boundHeadSha !== live.headSha && !bound.reportedShas.includes(live.headSha) && github?.contains) {
        attribution = { descendsFromBound: await github.contains(fact.repoFullName, bound.boundHeadSha, live.headSha) };
      }
      const d = view.delivery;
      const carryForward = live ? await carryForwardEvidence(view, fact.repoFullName, live, exec, github) : null;
      return {
        command: { type: 'HeadObserved', actor, hintedHeadSha: fact.hintedHeadSha ?? null, live: live!, ...(proof ? { proof } : {}), ...(carryForward ? { carryForward } : {}), ...(attribution ? { attribution } : {}) },
        ref,
        payload: { hintedHeadSha: fact.hintedHeadSha ?? null, live, proof: proof ?? null, carryForward, attribution: attribution ?? null },
        repoFullName: fact.repoFullName, prNumber: fact.prNumber,
        held: d ? { deliveryId: d.id, headSha: d.currentHeadSha, version: d.version, state: d.state, round: d.currentRound } : null,
      };
    }
    case 'pr_closed': {
      const ref: DeliveryRef = { workspaceId: fact.workspaceId, repoFullName: fact.repoFullName, prNumber: fact.prNumber };
      const closedUnmerged = !live!.merged && live!.state !== 'open';
      // The cause is read, never guessed: only a base branch the live read cannot find is `base_deleted`.
      const baseExists = closedUnmerged && live!.baseRef && github?.branchExists
        ? await github.branchExists(fact.repoFullName, live!.baseRef)
        : null;
      const closeCause: CloseCause = baseExists === false ? 'base_deleted' : 'unknown';
      const command: Command = live!.merged
        ? { type: 'PrMerged', actor, live: live! }
        : live!.state === 'open'
          ? { type: 'PrReopened', actor, live: live! }
          : { type: 'PrClosedUnmerged', actor, live: live!, closeCause };
      return { command, ref, payload: { live, ...(closedUnmerged ? { baseExists } : {}) }, repoFullName: fact.repoFullName, prNumber: fact.prNumber };
    }
    case 'composition_attested': {
      const att = fact.attestation;
      const rows = ((await exec(constituentEvidenceSql(fact.workspaceId, att.constituents.map((c) => c.roundId)))).rows ?? []) as Array<Record<string, unknown>>;
      const constituents: ConstituentEvidence[] = rows.map((r) => ({
        roundId: String(r.round_id),
        deliveryId: r.delivery_id == null ? null : String(r.delivery_id),
        prNumber: r.pr_number == null ? null : Number(r.pr_number),
        repoFullName: r.repo_full_name == null ? null : String(r.repo_full_name),
        roundHeadSha: r.head_sha == null ? null : String(r.head_sha),
        roundStatus: (r.status ?? null) as ConstituentEvidence['roundStatus'],
        effectiveVerdict: (r.effective_verdict ?? null) as ConstituentEvidence['effectiveVerdict'],
        deliveryApprovedHeads: (r.approved_heads as string[] | null) ?? [],
      }));
      return {
        command: { type: 'CompositionAttested', actor, attestation: att, constituents },
        ref: { workspaceId: fact.workspaceId, repoFullName: att.repoFullName, prNumber: att.prNumber },
        payload: { attestation: att },
        repoFullName: att.repoFullName, prNumber: att.prNumber,
      };
    }
  }
}
