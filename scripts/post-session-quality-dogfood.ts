#!/usr/bin/env bun
/**
 * Post-session quality loop — the shadow-to-propose gate for one workspace.
 *
 * Reads the workspace's `post_session_runs` and `post_session_findings` for the
 * current policy version and checks them against the spec (artifact
 * `post-session-quality-loop-spec` §4–§9, §12): one row per worker, a complete
 * triage record with hard-trigger provenance, coverage written on every
 * analysed run, evidence on every finding, and nothing filed while in shadow.
 * Prints a readout and a verdict. Read-only: it writes nothing, and switching
 * the workspace to `propose` stays a deliberate step through the supported
 * runtime config path (`manage_workspaces action=update` with
 * `gitConfig.postSessionQuality.mode = 'propose'`).
 *
 * Run from the repo root (needs a DATABASE_URL that can read those tables):
 *   bun run scripts/post-session-quality-dogfood.ts <workspaceId>
 *
 * Exit code: 0 ready, 1 not ready, 2 usage or connection error.
 */

import { POST_SESSION_POLICY_VERSION, resolvePostSessionQualityMode } from '../packages/core/post-session-quality';
import { TRIAGE_UNAVAILABLE } from '../packages/core/post-session-triage';

export interface DogfoodRun {
  id: string;
  workerId: string;
  mode: string;
  state: string;
  triage: {
    status?: string;
    decision?: string | null;
    focus?: string | null;
    reasonCode?: string | null;
    confidence?: number | null;
    provenance?: Record<string, unknown>;
  } | null;
  hardTriggered: boolean | null;
  hardTriggerReasons: string[] | null;
  finalDecision: string | null;
  traceAvailability: string | null;
  errorStage: string | null;
}

export interface DogfoodFinding {
  id: string;
  class: string;
  severity: string;
  confidence: string | number | null;
  title: string;
  occurrenceCount: number;
  affectedRefs: Array<{ runId: string }>;
  evidenceRefs: Array<{ kind: string; ref: string }>;
  actionState: string;
  actionTaskId: string | null;
  actionArtifactId: string | null;
}

export interface DogfoodVerdict {
  ready: boolean;
  blockers: string[];
  readout: {
    runs: number;
    byState: Record<string, number>;
    triage: { ok: number; unavailable: number; byRule: Record<string, number>; hardTriggered: number };
    analysed: number;
    findings: number;
    actionable: number;
    byActionState: Record<string, number>;
  };
}

const TRIAGED_STATES = new Set(['triaged', 'skipped', 'analysing', 'analysed']);

function bump(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

function triageGap(run: DogfoodRun): string | null {
  const t = run.triage;
  if (!t) return 'no triage record';
  if (typeof t.provenance?.rule !== 'string') return 'triage record has no rule provenance';
  if (typeof run.hardTriggered !== 'boolean' || !Array.isArray(run.hardTriggerReasons)) return 'hard-trigger provenance missing';
  if (run.finalDecision !== 'skip' && run.finalDecision !== 'analyse') return 'no final decision';
  if (t.status === 'unavailable') return t.reasonCode === TRIAGE_UNAVAILABLE ? null : 'unavailable triage without its reason code';
  if (t.status === 'rule') return t.decision === 'analyse' && t.reasonCode ? null : 'rule triage without its decision or reason code';
  if (t.status !== 'ok') return `unknown triage status ${t.status}`;
  if (!t.decision || !t.focus || !t.reasonCode || typeof t.confidence !== 'number') return 'decision, focus, reason or confidence missing';
  return null;
}

/** Pure. The verdict a shadow pass has to earn before the workspace moves to propose. */
export function evaluateShadowReadiness(runs: DogfoodRun[], findings: DogfoodFinding[]): DogfoodVerdict {
  const blockers: string[] = [];
  const byState: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const byActionState: Record<string, number> = {};
  let ok = 0, unavailable = 0, hardTriggered = 0, analysed = 0;

  const perWorker = new Map<string, number>();
  for (const r of runs) {
    bump(byState, r.state);
    perWorker.set(r.workerId, (perWorker.get(r.workerId) ?? 0) + 1);
    if (!TRIAGED_STATES.has(r.state)) continue;
    const gap = triageGap(r);
    if (gap) blockers.push(`run ${r.id}: ${gap}`);
    if (r.triage?.status === 'ok') ok++;
    if (r.triage?.status === 'unavailable') unavailable++;
    if (r.hardTriggered) hardTriggered++;
    if (typeof r.triage?.provenance?.rule === 'string') bump(byRule, r.triage.provenance.rule);
    if (r.state === 'analysed') {
      analysed++;
      if (!r.traceAvailability) blockers.push(`run ${r.id}: analysed without trace coverage`);
    }
  }
  for (const [workerId, n] of perWorker) if (n > 1) blockers.push(`worker ${workerId}: ${n} runs for one policy version`);

  if (runs.length === 0) blockers.push('no runs: the loop has not run for this workspace (not deployed, mode off, or nothing terminal yet)');
  else if (ok === 0) blockers.push('no triage decision came back ok: the decision model has not been exercised');
  if (runs.length > 0 && analysed === 0) blockers.push('no run reached analysis: nothing proves a selected session yields a finding');

  const shadowRunIds = new Set(runs.filter(r => r.mode === 'shadow').map(r => r.id));
  let actionable = 0;
  for (const f of findings) {
    bump(byActionState, f.actionState);
    if (f.class !== 'no_action') actionable++;
    if (!f.evidenceRefs.some(e => e.kind === 'post_session_run')) {
      blockers.push(`finding ${f.id}: no post-session run in its evidence`);
    }
    if (f.affectedRefs.length === 0) blockers.push(`finding ${f.id}: no affected session`);
    const allShadow = f.affectedRefs.length > 0 && f.affectedRefs.every(a => shadowRunIds.has(a.runId));
    if (allShadow && (f.actionTaskId || f.actionArtifactId)) blockers.push(`finding ${f.id}: filed an action from shadow runs`);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    readout: {
      runs: runs.length,
      byState,
      triage: { ok, unavailable, byRule, hardTriggered },
      analysed,
      findings: findings.length,
      actionable,
      byActionState,
    },
  };
}

async function main(): Promise<number> {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error('usage: bun run scripts/post-session-quality-dogfood.ts <workspaceId>');
    return 2;
  }
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set');
    return 2;
  }
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  const { and, eq } = await import('drizzle-orm');
  const schema = await import('../packages/core/db/schema');
  const db = drizzle(neon(DATABASE_URL), { schema });
  const { postSessionRuns: r, postSessionFindings: f, workspaces } = schema;

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { id: true, gitConfig: true } });
  if (!ws) {
    console.error(`ERROR: workspace ${workspaceId} not found`);
    return 2;
  }
  const runs = await db.select({
    id: r.id, workerId: r.workerId, mode: r.mode, state: r.state, triage: r.triage, hardTriggered: r.hardTriggered,
    hardTriggerReasons: r.hardTriggerReasons, finalDecision: r.finalDecision, traceAvailability: r.traceAvailability,
    errorStage: r.errorStage,
  }).from(r).where(and(eq(r.workspaceId, workspaceId), eq(r.policyVersion, POST_SESSION_POLICY_VERSION)));
  const findings = await db.select({
    id: f.id, class: f.class, severity: f.severity, confidence: f.confidence, title: f.title,
    occurrenceCount: f.occurrenceCount, affectedRefs: f.affectedRefs, evidenceRefs: f.evidenceRefs,
    actionState: f.actionState, actionTaskId: f.actionTaskId, actionArtifactId: f.actionArtifactId,
  }).from(f).where(and(eq(f.workspaceId, workspaceId), eq(f.policyVersion, POST_SESSION_POLICY_VERSION)));

  const verdict = evaluateShadowReadiness(runs as DogfoodRun[], findings as DogfoodFinding[]);
  const mode = resolvePostSessionQualityMode(ws.gitConfig);
  console.log(JSON.stringify({ workspaceId, policyVersion: POST_SESSION_POLICY_VERSION, mode, ...verdict }, null, 2));
  if (verdict.ready && mode === 'shadow') {
    console.log('\nReady. Switch with: manage_workspaces action=update gitConfig={"postSessionQuality":{"mode":"propose"}}');
  }
  return verdict.ready ? 0 : 1;
}

if (import.meta.main) {
  main().then(code => process.exit(code), err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
