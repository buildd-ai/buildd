#!/usr/bin/env bun
/**
 * §4 delta gate for docs/design/spec-conformance.md.
 *
 * The Tier-2 CI job that evaluates spec/design frontmatter assertions is
 * cheap (filesystem + ripgrep, no LLM calls) but still worth skipping when
 * nothing relevant changed. §4's mechanism: a keyed buildd artifact
 * (`spec-conformance-last-sha`) records the last commit fully evaluated;
 * this script diffs that commit against the current HEAD and skips only
 * when the changed-file set has no intersection with the watch set
 * (`computeWatchSet` in packages/core/spec-conformance.ts — `docs/design/**`
 * UNION every path/file/entry an assertion references anywhere in the repo).
 *
 * Two subcommands, run as separate CI steps:
 *
 *   check   — decide skip/run for this invocation. Writes `skip` and
 *             `changed-count` to $GITHUB_OUTPUT. Never fails the build:
 *             any missing prerequisite (no WORKSPACE_ID, no BUILDD_API_KEY,
 *             cold start with no prior artifact, an unresolvable last-sha)
 *             fails OPEN — skip=false, run the checker — because the whole
 *             point of this gate is a latency optimization, not a
 *             correctness gate; the checker itself is what enforces §3.
 *
 *   record  — write the current HEAD sha back to the keyed artifact. Run
 *             this as a separate `if: always()` step AFTER the checker, so
 *             a failing checker still advances the recorded sha (§4: "on
 *             completion (pass or fail), the job writes the current HEAD
 *             sha back").
 *
 * Deliberately read-heavy, write-light: `check` only ever GETs the artifact
 * (safe from any number of concurrent PR runs), `record` only runs from a
 * single serialized trunk context (see the workflow file for which events
 * call which subcommand) — the same reasoning §7 gives for skipping an
 * optimistic-lock column on the ledger table applies here too.
 *
 * Usage:
 *   bun run scripts/spec-conformance-delta-gate.ts check --workspace-id <uuid>
 *   bun run scripts/spec-conformance-delta-gate.ts record --workspace-id <uuid> [--sha <sha>]
 *
 * Env: BUILDD_API_KEY (required for either subcommand to do anything but
 * fail open / no-op), BUILDD_SERVER (default https://buildd.dev).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWatchSet, isWatched, resolveConformanceConfig } from '../packages/core/spec-conformance';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const ARTIFACT_KEY = 'spec-conformance-last-sha';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// Overridable for tests only — every real CI invocation runs against the
// actual checkout, same as check-spec-conformance.ts and
// write-spec-discrepancies.ts (neither of which exposes this either).
const ROOT = argValue('--repo-root') ?? DEFAULT_ROOT;

function writeOutput(key: string, value: string) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) appendFileSync(outFile, `${key}=${value}\n`);
  console.log(`[spec-conformance-delta-gate] ${key}=${value}`);
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function getArtifact(serverUrl: string, apiKey: string, workspaceId: string): Promise<{ content: string | null } | null> {
  const res = await fetch(`${serverUrl}/api/workspaces/${workspaceId}/artifacts?key=${ARTIFACT_KEY}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.log(`[spec-conformance-delta-gate] artifact lookup failed (${res.status}) — failing open`);
    return null;
  }
  const data = (await res.json()) as { artifacts?: Array<{ content: string | null }> };
  return data.artifacts?.[0] ?? null;
}

async function cmdCheck() {
  const workspaceId = argValue('--workspace-id') ?? process.env.WORKSPACE_ID;
  const apiKey = process.env.BUILDD_API_KEY;
  const serverUrl = argValue('--server') ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev';

  const failOpen = (reason: string) => {
    console.log(`[spec-conformance-delta-gate] ${reason} — running the checker (fail open)`);
    writeOutput('skip', 'false');
    writeOutput('changed-count', '-1');
  };

  if (!workspaceId || !apiKey) {
    failOpen('WORKSPACE_ID or BUILDD_API_KEY not set');
    return;
  }

  const artifact = await getArtifact(serverUrl, apiKey, workspaceId);
  const lastSha = artifact?.content?.trim();
  if (!lastSha) {
    failOpen('no prior spec-conformance-last-sha artifact (cold start)');
    return;
  }

  try {
    git(['cat-file', '-e', lastSha]);
  } catch {
    failOpen(`recorded sha ${lastSha} is not reachable in this checkout`);
    return;
  }

  const changedFiles = git(['diff', '--name-only', lastSha, 'HEAD'])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  const config = resolveConformanceConfig({ repoRoot: ROOT });
  const watchSet = computeWatchSet(config);
  const watchedChanges = changedFiles.filter((f) => isWatched(f, watchSet));

  if (watchedChanges.length === 0) {
    console.log(`[spec-conformance-delta-gate] ${changedFiles.length} file(s) changed since ${lastSha}, none in the watch set`);
    writeOutput('skip', 'true');
    writeOutput('changed-count', '0');
  } else {
    console.log(`[spec-conformance-delta-gate] watched files changed since ${lastSha}:\n  ${watchedChanges.join('\n  ')}`);
    writeOutput('skip', 'false');
    writeOutput('changed-count', String(watchedChanges.length));
  }
}

async function cmdRecord() {
  const workspaceId = argValue('--workspace-id') ?? process.env.WORKSPACE_ID;
  const apiKey = process.env.BUILDD_API_KEY;
  const serverUrl = argValue('--server') ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev';
  const sha = argValue('--sha') ?? git(['rev-parse', 'HEAD']);

  if (!workspaceId || !apiKey) {
    console.log('[spec-conformance-delta-gate] WORKSPACE_ID or BUILDD_API_KEY not set — not recording');
    return;
  }

  const res = await fetch(`${serverUrl}/api/workspaces/${workspaceId}/artifacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'data',
      title: ARTIFACT_KEY,
      content: sha,
      key: ARTIFACT_KEY,
    }),
  });

  if (!res.ok) {
    console.log(`[spec-conformance-delta-gate] recording ${sha} failed (${res.status}) — next run fails open, not fatal`);
    return;
  }
  console.log(`[spec-conformance-delta-gate] recorded ${sha} as last-checked sha`);
}

const subcommand = process.argv[2];
if (subcommand === 'check') {
  await cmdCheck();
} else if (subcommand === 'record') {
  await cmdRecord();
} else {
  console.error('Usage: spec-conformance-delta-gate.ts <check|record> --workspace-id <uuid>');
  process.exit(1);
}
// fetch() keeps its keep-alive socket open past the last await, which would
// otherwise hang the process (and, under test, Bun.spawnSync waiting on it).
process.exit(0);
