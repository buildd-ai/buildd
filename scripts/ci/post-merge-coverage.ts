#!/usr/bin/env bun
/**
 * Decides whether a push to `dev` needs the post-merge API integration run
 * (.github/workflows/post-merge-integration.yml), and whether that run must
 * also start the preview runner.
 *
 * It used to diff `origin/main...HEAD`. After one server change landed on dev,
 * every later push, docs included, re-requested the full run on the one shared
 * test machine until the next release, because the server change stayed
 * "ahead of main" whether or not it had already been tested.
 *
 * Now the question is: what server code changed since the newest dev ancestor
 * whose integration tests actually ran and passed? Evidence is read from GitHub
 * (the run's jobs and steps), never assumed:
 *   - a run whose integration job was skipped, failed, cancelled or never ran
 *     is not evidence, so its changes stay in the diff until a run passes;
 *   - a run on a SHA that is not an ancestor of this head (another branch, a
 *     rewritten history) is not evidence;
 *   - an API run that did not start the runner is not runner evidence;
 *   - no evidence at all, or any error reading it, means test (fail closed).
 * Coverage is compared tree to tree (`git diff base head`), so a change that
 * was made and reverted in between counts as no change, which it is.
 *
 * A push that dev has already moved past skips with reason "superseded": the
 * newer push's run is queued behind this one on the workflow's concurrency
 * group and diffs from the same verified base, so it tests these changes too.
 * That is what coalesces a burst of merges into one run.
 *
 * A skipped run is never reported as passing: its integration check-run is
 * "skipped", and release_status shows that as `skipped`, not `passing`.
 */

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';

// Anything the API server or its integration tests load. Conservative on
// purpose: a false positive costs one run, a false negative ships untested code.
export const API_PATHS =
  /^(apps\/web\/|packages\/|bun\.lock$|package\.json$|tsconfig[^/]*\.json$|turbo\.json$|bunfig\.toml$|scripts\/seed-integration-fixtures\.ts$)/;
// Runner code: the integration-config tests need the preview runner started.
export const RUNNER_PATHS = /^apps\/runner\//;
// The job body and this decision itself: a change to either is exactly what
// the run has to exercise, with everything it can start.
export const SELF_PATHS =
  /^(\.github\/workflows\/(post-merge-)?integration\.yml$|scripts\/ci\/post-merge-coverage\.ts$)/;

export function classifyPaths(files: string[]): { api: boolean; runner: boolean } {
  const self = files.some((f) => SELF_PATHS.test(f));
  return {
    api: self || files.some((f) => API_PATHS.test(f)),
    runner: self || files.some((f) => RUNNER_PATHS.test(f)),
  };
}

export interface PriorRun {
  id: number;
  sha: string;
  url: string;
}

// What a completed run actually exercised, read from its job and steps.
export interface RunEvidence {
  api: boolean; // the integration tests step ran and succeeded
  runner: boolean; // ...and the preview runner was started for it
}

export interface Base {
  sha: string;
  url: string;
}

export interface Decision {
  api: boolean;
  runner: boolean;
  reason: 'manual' | 'superseded' | 'no-evidence' | 'diff-failed' | 'changed' | 'covered';
  detail: string;
  apiBase: Base | null;
  runnerBase: Base | null;
  changed: string[];
}

export interface DecideInput {
  event: string;
  headSha: string;
  // Current tip of dev, read when the job starts. null = unknown.
  devHeadSha: string | null;
  // Successful runs of this workflow on dev, newest first. null = could not list.
  runs: PriorRun[] | null;
  // Is `sha` an ancestor of (or equal to) `of`, default the head under test.
  isAncestor: (sha: string, of?: string) => Promise<boolean> | boolean;
  evidence: (run: PriorRun) => Promise<RunEvidence | null> | RunEvidence | null;
  // Files changed between base and head. null = could not diff.
  changedSince: (base: string) => Promise<string[] | null> | string[] | null;
  // Cap on evidence lookups (one API call each). Past it: no base, so test.
  maxLookups?: number;
}

const short = (sha: string) => sha.slice(0, 7);

export async function decide(input: DecideInput): Promise<Decision> {
  const none = { apiBase: null, runnerBase: null, changed: [] };

  // A manual run always tests everything it can: dispatching it is a request
  // for a verdict on this SHA, not for an opinion on whether one is needed.
  if (input.event === 'workflow_dispatch') {
    return { api: true, runner: true, reason: 'manual', detail: 'manual dispatch always tests', ...none };
  }

  if (
    input.devHeadSha &&
    input.devHeadSha !== input.headSha &&
    (await input.isAncestor(input.headSha, input.devHeadSha))
  ) {
    return {
      api: false,
      runner: false,
      reason: 'superseded',
      detail: `dev has moved on to ${short(input.devHeadSha)}; its run tests these changes from the same verified base`,
      ...none,
    };
  }

  if (!input.runs) {
    return { api: true, runner: true, reason: 'no-evidence', detail: 'could not list prior runs', ...none };
  }

  let apiBase: Base | null = null;
  let runnerBase: Base | null = null;
  let lookups = 0;
  const max = input.maxLookups ?? 40;
  for (const run of input.runs) {
    if (apiBase && runnerBase) break;
    if (lookups >= max) break;
    if (run.sha !== input.headSha && !(await input.isAncestor(run.sha))) continue;
    lookups++;
    const ev = await input.evidence(run);
    if (!ev?.api) continue;
    if (!apiBase) apiBase = { sha: run.sha, url: run.url };
    if (ev.runner && !runnerBase) runnerBase = { sha: run.sha, url: run.url };
  }

  if (!apiBase) {
    return {
      api: true,
      runner: true,
      reason: 'no-evidence',
      detail: 'no dev ancestor has a passing integration run',
      ...none,
    };
  }

  const changed = await input.changedSince(apiBase.sha);
  if (changed === null) {
    return { api: true, runner: true, reason: 'diff-failed', detail: `could not diff from ${short(apiBase.sha)}`, apiBase, runnerBase, changed: [] };
  }
  let runner: boolean;
  if (!runnerBase) {
    // No visible run ever verified the runner on this line, so whatever runner
    // code is here is unverified: fail closed.
    runner = true;
  } else if (runnerBase.sha === apiBase.sha) {
    runner = classifyPaths(changed).runner;
  } else {
    const runnerChanged = await input.changedSince(runnerBase.sha);
    runner = runnerChanged === null ? true : classifyPaths(runnerChanged).runner;
  }
  // The runner tests talk to the API server, so they need the API job too.
  const api = classifyPaths(changed).api || runner;

  if (!api) {
    return {
      api,
      runner,
      reason: 'covered',
      detail: `no server change since ${short(apiBase.sha)}, whose integration run passed`,
      apiBase,
      runnerBase,
      changed,
    };
  }
  return {
    api,
    runner,
    reason: 'changed',
    detail: runnerBase
      ? `server changes since ${short(apiBase.sha)} (API) / ${short(runnerBase.sha)} (runner)`
      : `server changes since ${short(apiBase.sha)}; no runner-verified base, so the runner is tested too`,
    apiBase,
    runnerBase,
    changed,
  };
}

// --- GitHub + git IO ---------------------------------------------------------

// The check-run name the evidence comes from: "<caller job> / <reusable job>".
export const INTEGRATION_JOB_NAME = 'post-merge integration / integration';
export const INTEGRATION_TESTS_STEP = 'Integration tests';
export const RUNNER_STEP = 'Start preview runner';

interface Job {
  name: string;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

export function evidenceFromJobs(jobs: Job[]): RunEvidence {
  const job = jobs.find((j) => j.name === INTEGRATION_JOB_NAME);
  if (!job || job.conclusion !== 'success') return { api: false, runner: false };
  const step = (n: string) => job.steps?.find((s) => s.name === n)?.conclusion === 'success';
  const api = step(INTEGRATION_TESTS_STEP);
  return { api, runner: api && step(RUNNER_STEP) };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function gh(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY!;
  const headSha = process.env.GITHUB_SHA!;
  const event = process.env.GITHUB_EVENT_NAME!;
  const workflow = process.env.WORKFLOW_FILE || 'post-merge-integration.yml';

  let devHeadSha: string | null = null;
  try {
    devHeadSha = git('ls-remote', 'origin', 'refs/heads/dev').split(/\s+/)[0] || null;
  } catch {}

  let runs: PriorRun[] | null = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const body = await gh(
        `/repos/${repo}/actions/workflows/${workflow}/runs?branch=dev&status=success&per_page=100&page=${page}`,
      );
      const batch = (body.workflow_runs ?? []) as Array<{ id: number; head_sha: string; html_url: string }>;
      runs.push(...batch.map((r) => ({ id: r.id, sha: r.head_sha, url: r.html_url })));
      if (batch.length < 100) break;
    }
  } catch (e) {
    console.log(`::warning::could not list prior runs: ${(e as Error).message}`);
    runs = null;
  }

  const decision = await decide({
    event,
    headSha,
    devHeadSha,
    runs,
    isAncestor: (sha, of = headSha) => {
      try {
        git('merge-base', '--is-ancestor', sha, of);
        return true;
      } catch {
        return false;
      }
    },
    evidence: async (run) => {
      try {
        const body = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        return evidenceFromJobs(body.jobs ?? []);
      } catch {
        return null;
      }
    },
    changedSince: (base) => {
      try {
        return git('diff', '--name-only', base, headSha).split('\n').filter(Boolean);
      } catch {
        return null;
      }
    },
  });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `api=${decision.api}\nrunner=${decision.runner}\nreason=${decision.reason}\n`);
    appendFileSync(out, `base=${decision.apiBase?.sha ?? ''}\n`);
  }
  console.log(`::notice::post-merge integration for ${short(headSha)}: api=${decision.api} runner=${decision.runner} (${decision.reason}: ${decision.detail})`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const verdict = decision.api ? 'requested' : 'NOT run (skipped; this is not a pass)';
    const lines = [
      '### Post-merge integration: coverage decision',
      '',
      '| | |',
      '|---|---|',
      `| Head SHA | \`${headSha}\` |`,
      `| Event | ${event} |`,
      `| Integration | ${verdict} |`,
      `| Runner tests | ${decision.runner} |`,
      `| Reason | ${decision.reason}: ${decision.detail} |`,
      `| Verified API base | ${decision.apiBase ? `\`${decision.apiBase.sha}\` ([run](${decision.apiBase.url}))` : 'none'} |`,
      `| Verified runner base | ${decision.runnerBase ? `\`${decision.runnerBase.sha}\` ([run](${decision.runnerBase.url}))` : 'none'} |`,
      '',
    ];
    if (decision.changed.length) {
      lines.push('<details><summary>Changed since the API base</summary>', '', '```', ...decision.changed.slice(0, 200), '```', '</details>', '');
    }
    appendFileSync(summary, lines.join('\n'));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    // The workflow step turns a failure here into api=true runner=true.
    console.log(`::error::coverage decision failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
