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
import type { CloseCause, CompositionAttestation, ConstituentEvidence } from './types';

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
   * Names of the checks and workflows that failed on `headSha` (§6.10: a CI
   * failure a preflight would have caught is tagged `preflight_miss`).
   * null = unreadable; never read as "nothing failed".
   */
  failingChecks?(repoFullName: string, headSha: string): Promise<string[] | null>;
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
      /** §8.3 carry-forward evidence the caller established for the live head (APPROVED/LANDING only). */
      carryForward?: (live: LivePr) => Promise<'content_equivalent' | 'own_refresh' | null>;
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
SELECT r.id AS round_id, r.head_sha, r.status, r.effective_verdict, d.approved_heads
FROM workflow_review_rounds r
JOIN workflow_deliveries d ON d.id = r.delivery_id
WHERE d.workspace_id = ${workspaceId}::uuid
  AND r.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(roundIds)}::jsonb))::uuid)`;
}

/** The natural key of a fact (§2 table). PR keys use the LIVE head. */
export function factKeyFor(f: FactInput, live?: LivePr | null): string {
  switch (f.kind) {
    case 'delivery_opened': return `open:${f.ownerTaskId}`;
    case 'pr_bound': return `bind:${f.repoFullName}#${f.prNumber}`;
    case 'head_observed': return `head:${f.repoFullName}#${f.prNumber}:${live?.headSha ?? 'unknown'}`;
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

  const factKey = factKeyFor(fact, live);
  const { command, ref, payload, repoFullName, prNumber } = await commandFor(fact, live, exec, deps.github);

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
  return { factId, factKey, firstSeen, ...result };
}

async function commandFor(fact: FactInput, live: LivePr | null, exec: Exec, github?: GithubFactReader): Promise<{
  command: Command; ref: DeliveryRef; payload: Record<string, unknown>; repoFullName: string | null; prNumber: number | null;
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
      const carryForward = d && live && live.headSha !== d.currentHeadSha && (d.state === 'APPROVED' || d.state === 'LANDING' || d.state === 'REPAIRING') && fact.carryForward
        ? await fact.carryForward(live)
        : null;
      return {
        command: { type: 'HeadObserved', actor, hintedHeadSha: fact.hintedHeadSha ?? null, live: live!, ...(proof ? { proof } : {}), ...(carryForward ? { carryForward } : {}), ...(attribution ? { attribution } : {}) },
        ref,
        payload: { hintedHeadSha: fact.hintedHeadSha ?? null, live, proof: proof ?? null, carryForward, attribution: attribution ?? null },
        repoFullName: fact.repoFullName, prNumber: fact.prNumber,
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
