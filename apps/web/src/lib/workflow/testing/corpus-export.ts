/**
 * Read recorded deliveries out of a database and write the sanitized replay
 * corpus (one delivery per JSONL line). The CLI is
 * `scripts/forensics/export-kernel-corpus.ts`; the SQL lives here because only
 * apps/web/src/lib/workflow/ touches the kernel tables
 * (packages/core/__tests__/workflow-write-sites.test.ts). Read-only.
 *
 * `query` is any `(text, params) => rows` over the neon HTTP driver (or a
 * local Postgres behind its proxy), so the module carries no database client
 * and no credential.
 */
import { appendFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORPUS_VERSION, type CorpusDelivery } from './corpus';
import { Pseudonymizer } from './sanitize';

type Row = Record<string, unknown>;
export type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

export interface ExportOptions {
  query: Query;
  out: string;
  /** ISO date: only deliveries created at or after it. */
  since?: string | null;
  limit?: number;
  /** Only this workspace's deliveries. */
  workspaceId?: string | null;
  /** Deliveries whose tasks failed, escalated, or hit gate refusals first. */
  errorsFirst?: boolean;
  /** Repository root the output must stay out of (default: the git toplevel of the output's directory, then of cwd). */
  repoRoot?: string | null;
  pseudonymizer?: Pseudonymizer;
}

const T_US = (col: string) => `floor(extract(epoch from (${col} - d.created_at)) * 1000000)::bigint`;

/**
 * The deliveries to export. With `errorsFirst`, a score ranks them: the owner
 * task failed (4), the delivery ended FAILED or ESCALATED (2), each failed
 * attempt or reviewer task (1), each gate refusal against any of its tasks
 * (1), and any worker error trace (1).
 */
export const SELECT_DELIVERIES = `-- workflow:corpus_select
WITH d AS (
  SELECT d.id, d.owner_task_id, d.state, d.created_at, t.status AS owner_status
  FROM workflow_deliveries d LEFT JOIN tasks t ON t.id = d.owner_task_id
  WHERE ($1::timestamptz IS NULL OR d.created_at >= $1::timestamptz)
    AND ($4::uuid IS NULL OR d.workspace_id = $4::uuid)
), related AS (
  SELECT d.id AS delivery_id, d.owner_task_id AS task_id FROM d
  UNION SELECT a.delivery_id, a.task_id FROM workflow_attempts a JOIN d ON d.id = a.delivery_id WHERE a.task_id IS NOT NULL
  UNION SELECT r.delivery_id, r.reviewer_task_id FROM workflow_review_rounds r JOIN d ON d.id = r.delivery_id WHERE r.reviewer_task_id IS NOT NULL
), scored AS (
  SELECT d.id, d.created_at,
    (CASE WHEN d.owner_status = 'failed' THEN 4 ELSE 0 END)
    + (CASE WHEN d.state IN ('FAILED', 'ESCALATED') THEN 2 ELSE 0 END)
    + (SELECT count(*) FROM related rl JOIN tasks t ON t.id = rl.task_id WHERE rl.delivery_id = d.id AND t.id <> d.owner_task_id AND t.status = 'failed')
    + (SELECT count(*) FROM related rl JOIN gate_events g ON g.task_id = rl.task_id WHERE rl.delivery_id = d.id AND g.outcome IN ('rejected', 'stranded'))
    + (CASE WHEN EXISTS (SELECT 1 FROM related rl JOIN worker_error_traces e ON e.task_id = rl.task_id WHERE rl.delivery_id = d.id) THEN 1 ELSE 0 END) AS score
  FROM d
)
SELECT id FROM scored
ORDER BY CASE WHEN $2::boolean THEN score ELSE 0 END DESC, created_at DESC, id
LIMIT $3`;

const IDS = `(SELECT unnest($1::uuid[]))`;

export const SELECT_ROWS = {
  deliveries: `-- workflow:corpus_deliveries
SELECT d.id, d.workspace_id, d.owner_task_id, d.repo_full_name, d.pr_number, d.base_ref, d.state, d.state_reason, d.version,
  d.current_head_sha, d.current_round, d.max_rounds, d.approved_heads, d.approval_basis, d.composition_heads, d.authority,
  to_jsonb(d.created_at) #>> '{}' AS created_at, t.status AS owner_status
FROM workflow_deliveries d LEFT JOIN tasks t ON t.id = d.owner_task_id
WHERE d.id IN ${IDS}`,
  // An unapplied fact has no delivery_id: it belongs to the delivery by PR, or by owner task for an open.
  facts: `-- workflow:corpus_facts
SELECT d.id AS delivery_id, f.id, f.kind, f.fact_key, f.source, f.repo_full_name, f.pr_number, f.payload, f.applied_transition_id, ${T_US('f.observed_at')} AS t_us
FROM workflow_deliveries d
JOIN workflow_facts f ON f.delivery_id = d.id
  OR (f.delivery_id IS NULL AND f.workspace_id = d.workspace_id
      AND ((d.pr_number IS NOT NULL AND f.repo_full_name = d.repo_full_name AND f.pr_number = d.pr_number) OR f.fact_key = 'open:' || d.owner_task_id::text))
WHERE d.id IN ${IDS}
ORDER BY f.observed_at, f.id`,
  transitions: `-- workflow:corpus_transitions
SELECT d.id AS delivery_id, t.id, t.from_version, t.to_version, t.from_state, t.to_state, t.command, t.idempotency_key, t.actor, t.evidence, t.bypass, ${T_US('t.created_at')} AS t_us
FROM workflow_deliveries d JOIN workflow_transitions t ON t.delivery_id = d.id
WHERE d.id IN ${IDS}
ORDER BY t.to_version`,
  effects: `-- workflow:corpus_effects
SELECT d.id AS delivery_id, e.id, e.transition_id, e.kind, e.dedupe_key, e.payload, e.status, e.outcome, ${T_US('e.created_at')} AS t_us
FROM workflow_deliveries d JOIN workflow_effects e ON e.delivery_id = d.id
WHERE d.id IN ${IDS}
ORDER BY e.created_at, e.id`,
  rounds: `-- workflow:corpus_rounds
SELECT d.id AS delivery_id, r.id, r.round, r.head_sha, r.kind, r.prior_round, r.scope, r.status, r.verdict, r.effective_verdict, r.confidence, r.failure_count, ${T_US('r.created_at')} AS t_us
FROM workflow_deliveries d JOIN workflow_review_rounds r ON r.delivery_id = d.id
WHERE d.id IN ${IDS}
ORDER BY r.round`,
  attempts: `-- workflow:corpus_attempts
SELECT d.id AS delivery_id, a.id, a.family, a.attempt_no, a.mode, a.bound_head_sha, a.trigger_reason, a.trigger_fact_id, a.task_id, a.trigger,
  a.reported_shas, a.pushed_head_sha, a.status, a.outcome, a.max_attempts, ${T_US('a.created_at')} AS t_us, t.status AS task_status
FROM workflow_deliveries d JOIN workflow_attempts a ON a.delivery_id = d.id LEFT JOIN tasks t ON t.id = a.task_id
WHERE d.id IN ${IDS}
ORDER BY a.family, a.mode, a.attempt_no`,
  // Gate events and error traces of every task the delivery ran: owner, repairs, reviewers.
  gateEvents: `-- workflow:corpus_gate_events
WITH rel AS (
  SELECT d.id AS delivery_id, d.owner_task_id AS task_id, d.created_at FROM workflow_deliveries d WHERE d.id IN ${IDS}
  UNION SELECT d.id, a.task_id, d.created_at FROM workflow_deliveries d JOIN workflow_attempts a ON a.delivery_id = d.id WHERE d.id IN ${IDS} AND a.task_id IS NOT NULL
  UNION SELECT d.id, r.reviewer_task_id, d.created_at FROM workflow_deliveries d JOIN workflow_review_rounds r ON r.delivery_id = d.id WHERE d.id IN ${IDS} AND r.reviewer_task_id IS NOT NULL
)
SELECT rel.delivery_id, g.gate, g.surface, g.outcome, floor(extract(epoch from (g.occurred_at - rel.created_at)) * 1000000)::bigint AS t_us
FROM rel JOIN gate_events g ON g.task_id = rel.task_id
ORDER BY g.occurred_at`,
  errorPatterns: `-- workflow:corpus_error_patterns
WITH rel AS (
  SELECT d.id AS delivery_id, d.owner_task_id AS task_id FROM workflow_deliveries d WHERE d.id IN ${IDS}
  UNION SELECT d.id, a.task_id FROM workflow_deliveries d JOIN workflow_attempts a ON a.delivery_id = d.id WHERE d.id IN ${IDS} AND a.task_id IS NOT NULL
)
SELECT rel.delivery_id, e.pattern, count(*)::int AS n
FROM rel JOIN worker_error_traces e ON e.task_id = rel.task_id
GROUP BY rel.delivery_id, e.pattern`,
} as const;

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string | null => (v == null ? null : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

function gitToplevel(dir: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Nearest existing ancestor, resolved through symlinks (macOS /tmp is /private/tmp). */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(cur.slice(dirname(cur).length + 1)); cur = dirname(cur); }
  return [realpathSync(cur), ...tail].join(sep);
}

/**
 * Throws when `out` is inside a git work tree: the corpus describes real
 * deliveries and must never be committable to this (public) repo. Checks both
 * the given root and the work tree the output directory itself belongs to.
 */
export function assertOutsideRepo(out: string, repoRoot?: string | null): void {
  const target = realish(out);
  const roots = new Set<string>();
  for (const r of [repoRoot ?? null, gitToplevel(process.cwd())]) if (r) roots.add(realish(r));
  let dir = dirname(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const own = gitToplevel(dir);
  if (own) roots.add(realish(own));
  for (const root of roots) {
    if (target === root || target.startsWith(root + sep)) {
      throw new Error(`refusing to write the corpus inside a git work tree (${root}); give a path outside the repository`);
    }
  }
}

function group(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r.delivery_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

/** Raw (unsanitized) corpus lines for these delivery ids, in the given order. */
export async function loadRaw(query: Query, ids: string[]): Promise<Array<{ createdAt: string; line: CorpusDelivery }>> {
  if (ids.length === 0) return [];
  const p = [ids];
  const [ds, fs, ts, es, rs, as, gs, ps] = await Promise.all([
    query(SELECT_ROWS.deliveries, p), query(SELECT_ROWS.facts, p), query(SELECT_ROWS.transitions, p), query(SELECT_ROWS.effects, p),
    query(SELECT_ROWS.rounds, p), query(SELECT_ROWS.attempts, p), query(SELECT_ROWS.gateEvents, p), query(SELECT_ROWS.errorPatterns, p),
  ]);
  const [F, T, E, R, A, G, P] = [fs, ts, es, rs, as, gs, ps].map(group);
  const byId = new Map(ds.map((d) => [String(d.id), d]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const d = byId.get(id)!;
    const attempts = A.get(id) ?? [];
    const line: CorpusDelivery = {
      v: CORPUS_VERSION,
      delivery: {
        id, workspaceId: String(d.workspace_id), ownerTaskId: String(d.owner_task_id), repoFullName: s(d.repo_full_name),
        prNumber: d.pr_number == null ? null : n(d.pr_number), baseRef: s(d.base_ref), state: String(d.state), stateReason: s(d.state_reason),
        version: n(d.version), currentHeadSha: s(d.current_head_sha), currentRound: n(d.current_round), maxRounds: n(d.max_rounds),
        approvedHeads: arr(d.approved_heads), approvalBasis: s(d.approval_basis), compositionHeads: arr(d.composition_heads), authority: String(d.authority ?? 'kernel'),
      },
      outcome: {
        ownerTaskStatus: s(d.owner_status),
        attemptTaskStatuses: attempts.map((a) => s(a.task_status)).filter((x): x is string => !!x),
        gateRefusals: (G.get(id) ?? []).filter((g) => g.outcome === 'rejected' || g.outcome === 'stranded').length,
        errorPatterns: Object.fromEntries((P.get(id) ?? []).map((r) => [String(r.pattern), n(r.n)])),
      },
      facts: (F.get(id) ?? []).map((f) => ({
        id: String(f.id), kind: String(f.kind), factKey: String(f.fact_key), source: String(f.source), repoFullName: s(f.repo_full_name),
        prNumber: f.pr_number == null ? null : n(f.pr_number), payload: obj(f.payload), appliedTransitionId: s(f.applied_transition_id), tUs: n(f.t_us),
      })),
      transitions: (T.get(id) ?? []).map((t) => ({
        id: String(t.id), fromVersion: n(t.from_version), toVersion: n(t.to_version), fromState: s(t.from_state), toState: String(t.to_state),
        command: String(t.command), idempotencyKey: String(t.idempotency_key), actor: String(t.actor), evidence: obj(t.evidence),
        bypass: t.bypass == null ? null : obj(t.bypass), tUs: n(t.t_us),
      })),
      effects: (E.get(id) ?? []).map((e) => ({
        id: String(e.id), transitionId: String(e.transition_id), kind: String(e.kind), dedupeKey: String(e.dedupe_key), payload: obj(e.payload),
        status: String(e.status), outcome: s(e.outcome), tUs: n(e.t_us),
      })),
      rounds: (R.get(id) ?? []).map((r) => ({
        id: String(r.id), round: n(r.round), headSha: String(r.head_sha), kind: String(r.kind), priorRound: r.prior_round == null ? null : n(r.prior_round),
        scope: r.scope == null ? null : obj(r.scope), status: String(r.status), verdict: s(r.verdict), effectiveVerdict: s(r.effective_verdict),
        confidence: r.confidence == null ? null : Number(r.confidence), failureCount: n(r.failure_count), tUs: n(r.t_us),
      })),
      attempts: attempts.map((a) => ({
        id: String(a.id), family: String(a.family), attemptNo: n(a.attempt_no), mode: String(a.mode), boundHeadSha: s(a.bound_head_sha),
        triggerReason: s(a.trigger_reason), triggerFactId: s(a.trigger_fact_id), taskId: s(a.task_id), trigger: String(a.trigger ?? 'automatic'),
        reportedShas: arr(a.reported_shas), pushedHeadSha: s(a.pushed_head_sha), status: String(a.status), outcome: s(a.outcome),
        maxAttempts: n(a.max_attempts), tUs: n(a.t_us),
      })),
      gateEvents: (G.get(id) ?? []).map((g) => ({ gate: String(g.gate), surface: String(g.surface), outcome: String(g.outcome), tUs: n(g.t_us) })),
    };
    return { createdAt: String(d.created_at), line };
  });
}

/** One sanitized line. `collect` must already have seen every raw line of the export. */
export function sanitizeLine(p: Pseudonymizer, raw: { createdAt: string; line: CorpusDelivery }): CorpusDelivery {
  const created = Date.parse(raw.createdAt);
  if (Number.isNaN(created)) throw new Error('delivery without a parseable created_at');
  return p.value(raw.line, created);
}

export async function exportCorpus(opts: ExportOptions): Promise<{ written: number; out: string }> {
  assertOutsideRepo(opts.out, opts.repoRoot);
  const limit = opts.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  if (opts.since && Number.isNaN(Date.parse(opts.since))) throw new Error('--since must be an ISO date');
  const ids = (await opts.query(SELECT_DELIVERIES, [opts.since ?? null, !!opts.errorsFirst, limit, opts.workspaceId ?? null])).map((r) => String(r.id));
  const p = opts.pseudonymizer ?? new Pseudonymizer();
  const raw: Array<{ createdAt: string; line: CorpusDelivery }> = [];
  for (let i = 0; i < ids.length; i += 50) raw.push(...await loadRaw(opts.query, ids.slice(i, i + 50)));
  for (const r of raw) p.collect(r.line);
  writeFileSync(opts.out, '');
  for (const r of raw) appendFileSync(opts.out, `${JSON.stringify(sanitizeLine(p, r))}\n`);
  return { written: raw.length, out: opts.out };
}
