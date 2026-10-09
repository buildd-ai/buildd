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
 * the T13 own-refresh check), an attempt's runner-reported local head
 * (`recordLocalHead`, read by §6.9 attribution) and an attempt end no
 * transition wrote (an unbound worker end, `outOfBandAttemptEnds`).
 *
 * What is not a decision is not compared (reconstruct.ts, by provenance):
 *  - `activity_note` facts are not steps (`OUT_OF_BAND_FACT_KINDS`);
 *  - effects a LATER statement hung on a transition (the drain's next
 *    `push_recovery` try, the floor's owed effect, a note's render) are not that
 *    step's decision (`isDecisionEffect`). They are written into the replay
 *    database at their recorded position instead, under the replay's ids, so
 *    the dedupe keys they hold and the outcomes later reads see are the ones
 *    production had.
 * Both sides of a step are compared after `redactProse` (the exporter's own
 * rule), and after the documented `KNOWN_EVOLUTIONS` whose exact shape matches;
 * a delivery that needed one lists it in `tolerated`.
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { FactInput } from '../facts';
import { ingestFact } from '../facts';
import { applyCommand, loadView, type CommandResult, type Exec } from '../kernel';
import type { KernelView } from '../types';
import type { CorpusDelivery, CorpusEffect, CorpusFact, CorpusTransition } from './corpus';
import { firstDivergence, normalizeForCompare, remapIds, summary, type Divergence, type StepDecision } from './diff';
import { recordedReader, UnansweredRead } from './recorded-github';
import { allocatedIds, buildSteps, isDecisionEffect, outOfBandAttemptEnds, outOfBandEffects, outOfBandFacts, reconstructCommand, stepTime, type Step } from './reconstruct';
import { redactProse } from './sanitize';

/** What the replay left out of the comparison, by provenance: never a decision. */
export interface OutOfBand { facts: number; effects: number }

type Common = { deliveryId: string; steps: number; inferred: string[]; tolerated: string[]; outOfBand: OutOfBand };
export type DeliveryReport =
  | (Common & { result: 'identical' })
  | (Common & { result: 'diverged'; stepIndex: number; step: string; divergence: Divergence; recorded: string; replayed: string })
  | (Common & { result: 'incomplete'; stepIndex: number; step: string; reason: string; replayedIdentical: number });

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
    effects: c.effects.filter((e) => isDecisionEffect(e, t)).map((e) => ({ kind: e.kind, dedupeKey: e.dedupeKey, payload: e.payload })),
  };
}

type Produced = { transitionId: string | null; decision: StepDecision; effectIds: Map<string, string> };

async function producedSince(exec: Exec, deliveryId: string | null, sinceVersion: number): Promise<Produced> {
  const none: Produced = { transitionId: null, decision: { transition: null, effects: [] }, effectIds: new Map() };
  if (!deliveryId) return none;
  const ts = await rowsOf(exec, sql`SELECT id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence, bypass
    FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND to_version > ${sinceVersion} ORDER BY to_version`);
  if (ts.length > 1) throw new Error(`replay: one step wrote ${ts.length} transitions`);
  const t = ts[0];
  if (!t) return none;
  // The statement's own effects only (one now()): out-of-band rows re-applied onto this transition are not its decision.
  const fx = await rowsOf(exec, sql`SELECT e.id, e.kind, e.dedupe_key, e.payload FROM workflow_effects e
    JOIN workflow_transitions t ON t.id = e.transition_id
    WHERE e.transition_id = ${String(t.id)}::uuid AND e.created_at = t.created_at`);
  return {
    transitionId: String(t.id),
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
    case 'base_changed':
      if (!f.repoFullName || f.prNumber == null) return { unreplayable: 'base_changed without a PR' };
      return { kind: 'base_changed', workspaceId: ws, source: f.source, repoFullName: f.repoFullName, prNumber: f.prNumber, hintedFromBase: (p.hintedFromBase ?? null) as string | null };
    case 'activity_note':
      // buildSteps never makes one a step (OUT_OF_BAND_FACT_KINDS); reaching here is a harness bug.
      return { unreplayable: 'activity_note is out of band and must not be a step' };
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

/**
 * Write the recorded out-of-band effects due before `beforeUs` into the replay
 * database, under the replay's delivery, transition and fact ids, with their
 * recorded drain status. A row whose transition the replay has not produced is
 * left for later; `ON CONFLICT` keeps an already-written key.
 */
async function applyOutOfBand(
  exec: Exec, pending: CorpusEffect[], beforeUs: number, replayDid: string | null,
  transitionIds: Map<string, string>, toReplay: Map<string, string>, inferred: Set<string>,
): Promise<void> {
  if (!replayDid) return;
  for (let i = 0; i < pending.length;) {
    const e = pending[i];
    const tid = transitionIds.get(e.transitionId);
    if (e.tUs >= beforeUs || !tid) { i++; continue; }
    pending.splice(i, 1);
    const key = remapIds(e.dedupeKey, toReplay);
    const payload = remapIds(e.payload ?? {}, toReplay);
    await exec(sql`INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, status, outcome)
      VALUES (${replayDid}::uuid, ${tid}::uuid, ${e.kind}::text, ${key}::text, ${JSON.stringify(payload)}::jsonb, ${e.status}::text, ${e.outcome})
      ON CONFLICT (dedupe_key) DO NOTHING`);
    inferred.add('effect (out-of-band row, re-applied at its recorded position)');
  }
}

/**
 * Write the attempt ends the transition log does not carry (`outOfBandAttemptEnds`)
 * with their recorded status and outcome. Returns whether any row changed.
 */
async function applyAttemptEnds(exec: Exec, ends: ReturnType<typeof outOfBandAttemptEnds>, replayDid: string, inferred: Set<string>): Promise<boolean> {
  let changed = false;
  for (const e of ends) {
    const rows = await rowsOf(exec, sql`UPDATE workflow_attempts SET status = ${e.status}::text, outcome = ${e.outcome}::text, ended_at = now(), updated_at = now()
      WHERE id = ${e.attemptId}::uuid AND delivery_id = ${replayDid}::uuid AND status IN ('queued', 'running') RETURNING id`);
    if (!rows.length) continue;
    changed = true;
    inferred.add(e.timed ? 'attempt end (out-of-band row, re-applied at its recorded time)' : 'attempt end (out-of-band, unbound worker end; time not recorded)');
  }
  return changed;
}

export async function replayDelivery(c: CorpusDelivery, opts: ReplayOptions): Promise<DeliveryReport> {
  const { exec } = opts;
  const steps = buildSteps(c);
  const inferred = new Set<string>();
  const tolerated = new Set<string>();
  const recordedDid = c.delivery.id;
  const factIds = new Map<string, string>();
  /** Recorded transition id → the replay's, for the steps that reproduced it. */
  const transitionIds = new Map<string, string>();
  const pendingOutOfBand = outOfBandEffects(c);
  const outOfBand: OutOfBand = { facts: outOfBandFacts(c).length, effects: pendingOutOfBand.length };
  let replayDid: string | null = null;
  let identical = 0;
  type Body = DeliveryReport extends infer R ? (R extends DeliveryReport ? Omit<R, keyof Common> : never) : never;
  const done = (r: Body): DeliveryReport =>
    ({ deliveryId: recordedDid, steps: steps.length, inferred: [...inferred].sort(), tolerated: [...tolerated].sort(), outOfBand, ...r }) as DeliveryReport;
  const toReplay = (): Map<string, string> => {
    const m = new Map<string, string>();
    if (replayDid) m.set(recordedDid, replayDid);
    for (const [rec, rep] of factIds) m.set(rec, rep);
    return m;
  };

  await setUp(exec, c);
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await applyOutOfBand(exec, pendingOutOfBand, stepTime(s), replayDid, transitionIds, toReplay(), inferred);
      let view: KernelView = replayDid
        ? await loadView({ deliveryId: replayDid }, exec)
        : await loadView({ workspaceId: c.delivery.workspaceId, ownerTaskId: c.delivery.ownerTaskId }, exec);
      if (replayDid && await applyAttemptEnds(exec, outOfBandAttemptEnds(c, view, stepTime(s)), replayDid, inferred)) {
        view = await loadView({ deliveryId: replayDid }, exec);
      }
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
      const cmp = normalizeForCompare(recordedDecision(c, s.expected), remapIds(produced.decision, idMap), redactProse);
      const { recorded, replayed } = cmp;
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
      cmp.tolerated.forEach((x) => tolerated.add(x));
      if (s.expected && produced.transitionId) transitionIds.set(s.expected.id, produced.transitionId);

      // Re-apply the recorded drain outcome of each effect the step enqueued.
      for (const e of c.effects.filter((x) => !!s.expected && isDecisionEffect(x, s.expected))) {
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
  /** Rows left out of the comparison by provenance, over every delivery. */
  outOfBand: OutOfBand;
  /** Known evolution id → deliveries that needed it. */
  tolerated: Record<string, number>;
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
    outOfBand: reports.reduce((o, r) => ({ facts: o.facts + r.outOfBand.facts, effects: o.effects + r.outOfBand.effects }), { facts: 0, effects: 0 }),
    tolerated: reports.reduce<Record<string, number>>((m, r) => { for (const t of r.tolerated) m[t] = (m[t] ?? 0) + 1; return m; }, {}),
    reports,
  };
}

/** The per-delivery report, one line each: identical, or the first divergent step with both decisions. */
export function formatReport(r: CorpusReport): string {
  const lines = [
    `kernel replay: ${r.deliveries} deliveries, ${r.identical} identical, ${r.diverged} diverged, ${r.incomplete} incomplete, ${r.stepsCompared} steps compared`,
    `  not compared (out of band, by provenance): ${r.outOfBand.facts} activity-note facts, ${r.outOfBand.effects} effects written by a later statement`,
    ...Object.entries(r.tolerated).sort().map(([id, n]) => `  tolerated known evolution: ${id} in ${n} deliveries`),
  ];
  for (const d of r.reports) {
    const inf = [d.inferred.length ? ` [inferred: ${d.inferred.join(', ')}]` : '', d.tolerated.length ? ` [tolerated: ${d.tolerated.join(', ')}]` : ''].join('');
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
