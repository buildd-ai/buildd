/**
 * Replay a recorded delivery through the CURRENT kernel and say whether it
 * still decides the same way.
 *
 * Each step runs the real code path against real Postgres: a fact goes through
 * `ingestFact` (answered by `recordedReader` instead of GitHub), a direct
 * command through `applyCommand`. The transition and effects the step wrote
 * are compared with the recorded ones (`firstDivergence`). The first
 * difference stops the delivery, because every later step would be judged
 * against a state the current code never reached.
 *
 * Isolation: every delivery gets its own throwaway team and workspace (under
 * the recorded, pseudonymous workspace id) and owner task, deleted afterwards,
 * so a corpus can be replayed into any migrated scratch database repeatedly.
 * Never point this at a database you care about: it writes kernel rows.
 *
 * Out-of-band writes the transition log does not carry are re-applied from the
 * recorded rows and named in `inferred`: an effect's drain outcome (read by
 * the T13 own-refresh check) and an attempt's runner-reported local head
 * (`recordLocalHead`, read by §6.9 attribution).
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { FactInput } from '../facts';
import { ingestFact } from '../facts';
import { applyCommand, loadView, type CommandResult, type Exec } from '../kernel';
import type { KernelView } from '../types';
import type { CorpusDelivery, CorpusFact, CorpusTransition } from './corpus';
import { firstDivergence, remapIds, summary, type Divergence, type StepDecision } from './diff';
import { recordedReader, UnansweredRead } from './recorded-github';
import { allocatedIds, buildSteps, reconstructCommand, type Step } from './reconstruct';

export type DeliveryReport =
  | { deliveryId: string; result: 'identical'; steps: number; inferred: string[] }
  | {
      deliveryId: string; result: 'diverged'; steps: number; stepIndex: number; step: string;
      divergence: Divergence; recorded: string; replayed: string; inferred: string[];
    }
  | { deliveryId: string; result: 'incomplete'; steps: number; stepIndex: number; step: string; reason: string; replayedIdentical: number; inferred: string[] };

type Row = Record<string, unknown>;
const rowsOf = async (exec: Exec, q: ReturnType<typeof sql>): Promise<Row[]> => ((await exec(q)).rows ?? []) as Row[];

function stepLabel(s: Step): string {
  return s.kind === 'fact' ? `fact ${s.fact.kind} (${s.fact.source})` : `command ${s.expected.command} (${s.expected.actor})`;
}

function recordedDecision(c: CorpusDelivery, t: CorpusTransition | null): StepDecision {
  if (!t) return { transition: null, effects: [] };
  return {
    transition: {
      command: t.command, fromState: t.fromState, toState: t.toState, fromVersion: t.fromVersion, toVersion: t.toVersion,
      idempotencyKey: t.idempotencyKey, actor: t.actor, evidence: t.evidence, bypass: t.bypass,
    },
    effects: c.effects.filter((e) => e.transitionId === t.id).map((e) => ({ kind: e.kind, dedupeKey: e.dedupeKey, payload: e.payload })),
  };
}

async function producedSince(exec: Exec, deliveryId: string | null, sinceVersion: number): Promise<{ decision: StepDecision; effectIds: Map<string, string> }> {
  if (!deliveryId) return { decision: { transition: null, effects: [] }, effectIds: new Map() };
  const ts = await rowsOf(exec, sql`SELECT id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence, bypass
    FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND to_version > ${sinceVersion} ORDER BY to_version`);
  if (ts.length > 1) throw new Error(`replay: one step wrote ${ts.length} transitions`);
  const t = ts[0];
  if (!t) return { decision: { transition: null, effects: [] }, effectIds: new Map() };
  const fx = await rowsOf(exec, sql`SELECT id, kind, dedupe_key, payload FROM workflow_effects WHERE transition_id = ${String(t.id)}::uuid`);
  return {
    decision: {
      transition: {
        command: String(t.command), fromState: (t.from_state ?? null) as string | null, toState: String(t.to_state),
        fromVersion: Number(t.from_version), toVersion: Number(t.to_version), idempotencyKey: String(t.idempotency_key),
        actor: String(t.actor), evidence: (t.evidence ?? {}) as Row, bypass: (t.bypass ?? null) as Row | null,
      },
      effects: fx.map((e) => ({ kind: String(e.kind), dedupeKey: String(e.dedupe_key), payload: (e.payload ?? {}) as Row })),
    },
    effectIds: new Map(fx.map((e) => [String(e.dedupe_key), String(e.id)])),
  };
}

function factInput(c: CorpusDelivery, f: CorpusFact): FactInput | { unreplayable: string } {
  const ws = c.delivery.workspaceId;
  const p = f.payload ?? {};
  switch (f.kind) {
    case 'delivery_opened':
      return { kind: 'delivery_opened', workspaceId: ws, source: f.source, ownerTaskId: String(p.ownerTaskId ?? c.delivery.ownerTaskId), requiresPr: p.requiresPr !== false, maxRounds: c.delivery.maxRounds };
    case 'pr_bound':
      if (!f.repoFullName || f.prNumber == null) return { unreplayable: 'pr_bound without a PR' };
      return { kind: 'pr_bound', workspaceId: ws, source: f.source, repoFullName: f.repoFullName, prNumber: f.prNumber, ownerTaskId: String(p.ownerTaskId ?? c.delivery.ownerTaskId), ...(p.adoption ? { adoption: true } : {}) };
    case 'head_observed':
      if (!f.repoFullName || f.prNumber == null) return { unreplayable: 'head_observed without a PR' };
      return { kind: 'head_observed', workspaceId: ws, source: f.source, repoFullName: f.repoFullName, prNumber: f.prNumber, hintedHeadSha: (p.hintedHeadSha ?? null) as string | null };
    case 'pr_closed':
      if (!f.repoFullName || f.prNumber == null) return { unreplayable: 'pr_closed without a PR' };
      return { kind: 'pr_closed', workspaceId: ws, source: f.source, repoFullName: f.repoFullName, prNumber: f.prNumber };
    case 'composition_attested':
      return { unreplayable: 'a composition is checked against its constituent deliveries, which are not part of this record' };
    default:
      return { unreplayable: `unknown fact kind ${f.kind}` };
  }
}

async function setUp(exec: Exec, c: CorpusDelivery): Promise<void> {
  const ws = c.delivery.workspaceId;
  await tearDown(exec, c);
  const slug = `replay-${randomUUID().slice(0, 12)}`;
  const [team] = await rowsOf(exec, sql`INSERT INTO teams (name, slug) VALUES (${slug}, ${slug}) RETURNING id`);
  await exec(sql`INSERT INTO workspaces (id, name, team_id) VALUES (${ws}::uuid, ${slug}, ${String(team.id)}::uuid)`);
  await exec(sql`INSERT INTO tasks (id, workspace_id, title, status) VALUES (${c.delivery.ownerTaskId}::uuid, ${ws}::uuid, ${slug}, 'in_progress')`);
}

async function tearDown(exec: Exec, c: CorpusDelivery): Promise<void> {
  const rows = await rowsOf(exec, sql`DELETE FROM workspaces WHERE id = ${c.delivery.workspaceId}::uuid RETURNING team_id`);
  for (const r of rows) await exec(sql`DELETE FROM teams WHERE id = ${String(r.team_id)}::uuid AND slug LIKE 'replay-%'`);
}

/**
 * Before a head fact: a local head the runner reported out of band
 * (`recordLocalHead`), which no transition records. `commandFor` skips the
 * §6.9 compare exactly when the bound attempt already lists the live head, so a
 * recorded fact with no attribution answer, for a bound attempt whose head
 * differs, means the head was on that list when it was read: put it there.
 */
async function syncReportedHead(exec: Exec, view: KernelView, f: CorpusFact, inferred: Set<string>): Promise<void> {
  const head = (f.payload?.live as Row | undefined)?.headSha;
  const d = view.delivery;
  const bound = view.attempts.find((a) => a.id === d?.boundAttemptId);
  if (typeof head !== 'string' || !d || !bound?.boundHeadSha || f.payload?.attribution) return;
  if (bound.boundHeadSha === head || bound.reportedShas.includes(head)) return;
  await exec(sql`UPDATE workflow_attempts SET reported_shas = array_append(reported_shas, ${head}::text)
    WHERE id = ${bound.id}::uuid AND delivery_id = ${d.id}::uuid AND NOT (${head}::text = ANY(reported_shas))`);
  inferred.add('attempt.reportedShas (runner-reported local head)');
}

export interface ReplayOptions {
  exec: Exec;
}

export async function replayDelivery(c: CorpusDelivery, opts: ReplayOptions): Promise<DeliveryReport> {
  const { exec } = opts;
  const steps = buildSteps(c);
  const inferred = new Set<string>();
  const recordedDid = c.delivery.id;
  const factIds = new Map<string, string>();
  let replayDid: string | null = null;
  let identical = 0;
  type Body = DeliveryReport extends infer R ? (R extends DeliveryReport ? Omit<R, 'deliveryId' | 'steps' | 'inferred'> : never) : never;
  const done = (r: Body): DeliveryReport =>
    ({ deliveryId: recordedDid, steps: steps.length, inferred: [...inferred].sort(), ...r }) as DeliveryReport;

  await setUp(exec, c);
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const view: KernelView = replayDid
        ? await loadView({ deliveryId: replayDid }, exec)
        : await loadView({ workspaceId: c.delivery.workspaceId, ownerTaskId: c.delivery.ownerTaskId }, exec);
      replayDid = view.delivery?.id ?? replayDid;
      const before = view.delivery?.version ?? 0;
      const pool = s.expected ? allocatedIds(c, s.expected) : [];
      const newId = () => pool.shift() ?? randomUUID();
      const incomplete = (reason: string) => done({ result: 'incomplete', stepIndex: i, step: stepLabel(s), reason, replayedIdentical: identical });

      let result: CommandResult | { result: string; reason?: string } | null = null;
      try {
        if (s.kind === 'fact') {
          const input = factInput(c, s.fact);
          if ('unreplayable' in input) return incomplete(input.unreplayable);
          if (replayDid) await syncReportedHead(exec, view, s.fact, inferred);
          const freshView = replayDid ? await loadView({ deliveryId: replayDid }, exec) : view;
          const r = await ingestFact(input, { exec, github: recordedReader(s.fact.payload ?? {}, freshView), newId });
          if (r.factId) factIds.set(s.fact.id, r.factId);
          result = r;
        } else {
          const rc = reconstructCommand(s.expected, { view, corpus: c, factIds });
          if (!rc.ok) return incomplete(rc.missing);
          rc.inferred.forEach((x) => inferred.add(`${s.expected.command}.${x}`));
          result = await applyCommand(rc.cmd, { ref: replayDid ? { deliveryId: replayDid } : undefined, exec, newId });
        }
      } catch (err) {
        if (err instanceof UnansweredRead) return incomplete(err.message);
        throw err;
      }

      if (!replayDid) {
        const v = await loadView({ workspaceId: c.delivery.workspaceId, ownerTaskId: c.delivery.ownerTaskId }, exec);
        replayDid = v.delivery?.id ?? null;
      }
      const produced = await producedSince(exec, replayDid, before);
      const idMap = new Map<string, string>();
      if (replayDid) idMap.set(replayDid, recordedDid);
      for (const [rec, rep] of factIds) idMap.set(rep, rec);
      const replayed = remapIds(produced.decision, idMap);
      const recorded = recordedDecision(c, s.expected);
      const div = firstDivergence(recorded, replayed);
      if (div) {
        const outcome = result && 'reason' in result && result.reason ? `${result.result}: ${result.reason}` : String(result?.result ?? 'nothing');
        return done({
          result: 'diverged', stepIndex: i, step: stepLabel(s), divergence: div,
          recorded: recorded.transition ? summary(recorded.transition) : 'no transition',
          replayed: replayed.transition ? summary(replayed.transition) : `no transition (${outcome})`,
        });
      }
      identical++;

      // Re-apply the recorded drain outcome of each effect the step enqueued.
      for (const e of c.effects.filter((x) => x.transitionId === s.expected?.id)) {
        const replayKey = replayDid ? e.dedupeKey.split(recordedDid).join(replayDid) : e.dedupeKey;
        const id = produced.effectIds.get(replayKey);
        if (!id || (e.status === 'pending' && e.outcome == null)) continue;
        await exec(sql`UPDATE workflow_effects SET status = ${e.status}, outcome = ${e.outcome} WHERE id = ${id}::uuid`);
        inferred.add('effect.status (drain outcome)');
      }
    }
    return done({ result: 'identical' });
  } finally {
    await tearDown(exec, c);
  }
}

export interface CorpusReport {
  deliveries: number;
  identical: number;
  diverged: number;
  incomplete: number;
  /** Steps whose recorded decision the replay reproduced, over every delivery. */
  stepsCompared: number;
  reports: DeliveryReport[];
}

export async function replayCorpus(corpus: CorpusDelivery[], opts: ReplayOptions): Promise<CorpusReport> {
  const reports: DeliveryReport[] = [];
  for (const c of corpus) reports.push(await replayDelivery(c, opts));
  const count = (r: DeliveryReport['result']) => reports.filter((x) => x.result === r).length;
  return {
    deliveries: reports.length,
    identical: count('identical'),
    diverged: count('diverged'),
    incomplete: count('incomplete'),
    stepsCompared: reports.reduce((n, r) => n + (r.result === 'identical' ? r.steps : r.result === 'incomplete' ? r.replayedIdentical : r.stepIndex + 1), 0),
    reports,
  };
}

/** The per-delivery report, one line each: identical, or the first divergent step with both decisions. */
export function formatReport(r: CorpusReport): string {
  const lines = [`kernel replay: ${r.deliveries} deliveries, ${r.identical} identical, ${r.diverged} diverged, ${r.incomplete} incomplete, ${r.stepsCompared} steps compared`];
  for (const d of r.reports) {
    const inf = d.inferred.length ? ` [inferred: ${d.inferred.join(', ')}]` : '';
    if (d.result === 'identical') lines.push(`  ${d.deliveryId}  identical (${d.steps} steps)${inf}`);
    else if (d.result === 'incomplete') lines.push(`  ${d.deliveryId}  incomplete at step ${d.stepIndex} ${d.step}: ${d.reason} (${d.replayedIdentical} identical before it)${inf}`);
    else {
      lines.push(`  ${d.deliveryId}  DIVERGED at step ${d.stepIndex} ${d.step}, field ${d.divergence.field}${inf}`);
      lines.push(`      recorded: ${d.recorded}`);
      lines.push(`      replayed: ${d.replayed}`);
      lines.push(`      recorded value: ${JSON.stringify(d.divergence.recorded)}`);
      lines.push(`      replayed value: ${JSON.stringify(d.divergence.replayed)}`);
    }
  }
  return lines.join('\n');
}
