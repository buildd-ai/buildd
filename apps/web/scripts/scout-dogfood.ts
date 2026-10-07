#!/usr/bin/env bun
/**
 * Run one bounded Quality Scout pass on a local checkout, with the local host
 * (`src/lib/quality-scout-local-host.ts`): the real pipeline, real commands,
 * real Visual QA captures when asked, and a local ledger. Nothing is written to
 * buildd: a "filed" follow-up lands in the local state file.
 *
 *   bun run scripts/scout-dogfood.ts <plan.json>
 *
 * The plan is the run's whole input, so keeping it next to the report keeps
 * the evidence reproducible:
 *
 *   {
 *     "workspaceId": "buildd", "dir": "/tmp/candidate",       // clean checkout of `sha`
 *     "ref": "main", "sha": "<40 hex>", "changedSince": "<sha>",
 *     "trigger": "manual", "dedupeKey": "a", "mode": "shadow",
 *     "extension": { ...gitConfig.qualityScout },
 *     "signals": { ...extra ScoutSignals: recentWork, recall, failures, criticalPaths },
 *     "capture": { "repo": "owner/name" },                    // optional: Visual QA via gh
 *     "budget": { "maxProbes": 4 }, "maxDurationMs": 1800000,
 *     "state": "state.json", "evidenceDir": "evidence", "report": "report.json"
 *   }
 *
 * `--server` mode exercises the production path instead: claim a parked run
 * from a live buildd (the server planned it with its own decider), host its
 * command probes in a throwaway worktree of `--repo`, and post the results
 * through the run API, exactly as a runner does. The key is BUILDD_API_KEY.
 * It never sandboxes, so it refuses unless BUILDD_SCOUT_UNSANDBOXED=1:
 *
 *   BUILDD_SCOUT_UNSANDBOXED=1 BUILDD_API_KEY=bld_… \
 *     bun run scripts/scout-dogfood.ts --server https://buildd.dev --repo /path/to/clone
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ScoutSignals } from '@buildd/core/quality-scout/candidates';
import type { ScoutProbePorts } from '@buildd/core/quality-scout/executors';
import type { ScoutMode, ScoutRunTrigger } from '@buildd/core/quality-scout/types';
import {
  exec,
  gitChangedPaths,
  gitScoutProfile,
  localCommandPort,
  localScoutStore,
  ruleScoutProbeDecider,
} from '../src/lib/quality-scout-local-host';
import { createScoutHostHttpApi, hostClaimedScoutRun, type ScoutClaimed } from '@buildd/core/quality-scout/runner-host';
import { runQualityScout } from '../src/lib/quality-scout-run';
import { createVisualQaCapturePort, type VisualQaActions, type VisualQaRun } from '../src/lib/quality-scout-visual-adapter';

interface Plan {
  workspaceId: string;
  dir: string;
  ref: string;
  sha: string;
  changedSince?: string;
  trigger?: ScoutRunTrigger;
  dedupeKey?: string;
  mode?: ScoutMode;
  extension?: unknown;
  signals?: Partial<ScoutSignals>;
  capture?: { repo: string };
  budget?: { maxProbes?: number; maxCostUsd?: number | null };
  maxDurationMs?: number;
  state: string;
  evidenceDir: string;
  report: string;
}

async function gh(args: string[]): Promise<string> {
  const r = await exec('gh', args, { cwd: process.cwd(), timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

const toRun = (r: Record<string, unknown>): VisualQaRun => ({
  id: r.id as number,
  status: r.status as string,
  conclusion: (r.conclusion as string | null) ?? null,
  headSha: r.head_sha as string,
  headBranch: (r.head_branch as string | null) ?? null,
  createdAt: r.created_at as string,
});

/** `VisualQaActions` over the gh CLI — the worker recipe in /visual-review, behind the same port. */
function ghVisualQaActions(repo: string): VisualQaActions {
  const wf = `repos/${repo}/actions/workflows/visual-qa.yml`;
  return {
    repoFullName: repo,
    async workflowExists() {
      try { await gh(['api', wf]); return true; } catch { return false; }
    },
    async dispatch(ref, inputs) {
      await gh(['workflow', 'run', 'visual-qa.yml', '--repo', repo, '--ref', ref, ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`])]);
    },
    async listDispatchRuns(ref) {
      const data = JSON.parse(await gh(['api', `${wf}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`]));
      return (data.workflow_runs ?? []).map(toRun);
    },
    async getRun(id) {
      return toRun(JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${id}`])));
    },
    async readArtifactFile(id, name, path) {
      const out = mkdtempSync(join(tmpdir(), 'scout-qa-'));
      try {
        await gh(['run', 'download', String(id), '--repo', repo, '-n', name, '-D', out]);
      } catch {
        return null;
      }
      const found = (await exec('bash', ['-c', `find . -name ${JSON.stringify(path.split('/').pop())} | head -1`], { cwd: out })).stdout.trim();
      return found ? readFileSync(join(out, found), 'utf8') : null;
    },
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** `owner/name` of a clone's origin, lowercase. */
async function originSlug(dir: string): Promise<string | null> {
  const url = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  const m = url.replace(/\.git$/, '').match(/[:/]([\w.-]+\/[\w.-]+)$/);
  return m ? m[1].toLowerCase() : null;
}

async function serverMode(serverUrl: string) {
  const repoDir = resolve(flag('--repo') ?? '');
  const apiKey = process.env.BUILDD_API_KEY;
  if (!apiKey) throw new Error('--server needs BUILDD_API_KEY');
  // Same rule as the runner: no sandbox here, so only on the operator's explicit say-so.
  if (process.env.BUILDD_SCOUT_UNSANDBOXED !== '1') throw new Error('--server runs probe commands unsandboxed; set BUILDD_SCOUT_UNSANDBOXED=1 to accept that');
  const slug = await originSlug(repoDir);
  if (!slug) throw new Error(`${repoDir} has no recognizable origin remote`);
  const api = createScoutHostHttpApi({ serverUrl, apiKey });
  const claim = await api.claim({ repos: [slug], ports: { command: true, capture: false, browser: false }, runnerId: 'scout-dogfood' });
  if (!claim.run) {
    console.log(JSON.stringify({ claimed: false, reason: claim.reason, expired: claim.expired ?? [] }));
    return;
  }
  const out = await hostClaimedScoutRun({ claimed: claim as ScoutClaimed, repoPath: repoDir, api, secretValues: [apiKey] });
  console.log(JSON.stringify({ claimed: true, runId: claim.run.id, sha: claim.run.candidate.sha, outcome: out }));
}

async function main() {
  const server = flag('--server');
  if (server) return serverMode(server);
  const planPath = resolve(process.argv[2] ?? '');
  const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const base = dirname(planPath);
  const at = (p: string) => resolve(base, p);
  const evidenceDir = at(plan.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });

  const store = localScoutStore(at(plan.state));
  const command = localCommandPort({ dir: plan.dir, evidenceDir });
  const ports: ScoutProbePorts = { command: command.port };
  if (plan.capture) ports.capture = createVisualQaCapturePort(ghVisualQaActions(plan.capture.repo));

  let changedPaths: string[] = [];
  const started = Date.now();
  const out = await runQualityScout(
    {
      workspaceId: plan.workspaceId,
      trigger: plan.trigger ?? 'manual',
      mode: plan.mode ?? 'shadow',
      candidate: { ref: plan.ref, sha: plan.sha },
      budget: plan.budget,
      maxDurationMs: plan.maxDurationMs,
      dedupeKey: plan.dedupeKey,
    },
    {
      now: () => new Date(),
      loadProfile: () => gitScoutProfile(plan.dir, plan.sha, plan.extension),
      gatherSignals: async ({ candidate, prior }) => {
        changedPaths = await gitChangedPaths(plan.dir, plan.changedSince ?? prior?.sha ?? `${candidate.sha}~1`, candidate.sha);
        return { ...plan.signals, candidateRef: candidate.ref, priorRef: prior?.sha ?? null, changedPaths };
      },
      decide: ruleScoutProbeDecider,
      ports,
      ledger: store.ledger,
      actions: store.actions,
      headSha: async () => (await exec('git', ['rev-parse', `origin/${plan.ref}`], { cwd: plan.dir })).stdout.trim() || null,
    },
  );

  const runId = out.runId;
  const probes = runId ? store.state.probes[runId] ?? [] : [];
  const report = {
    outcome: out,
    wallMs: Date.now() - started,
    exercised: { ref: plan.ref, sha: plan.sha },
    changedSince: plan.changedSince ?? null,
    changedPaths: changedPaths.length,
    probes: probes.map((p) => ({
      candidateId: p.candidateId,
      family: p.family,
      probeKind: p.probeKind,
      title: p.title,
      invariant: p.invariant,
      sourceSignals: p.sourceSignals,
      executor: p.executor,
      selection: p.selection,
      unsupportedReason: p.unsupportedReason,
      verdict: p.result?.verdict ?? null,
      reason: p.result?.reason ?? null,
      observed: p.result?.observed ?? null,
      evidenceRefs: p.result?.evidenceRefs ?? [],
      signature: p.result?.signature ?? null,
    })),
    commands: command.records.map((r) => ({
      command: r.request.command,
      exitCode: r.output.exitCode,
      timedOut: r.output.timedOut,
      durationMs: r.output.durationMs,
      evidenceRef: r.output.evidenceRef,
      treeChanges: r.treeChanges,
    })),
    findings: store.state.findings,
    tasks: store.state.tasks,
    writeAudit: store.audit,
    productWrites: store.productWrites(),
  };
  writeFileSync(at(plan.report), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: out.status, runId, report: at(plan.report) }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
