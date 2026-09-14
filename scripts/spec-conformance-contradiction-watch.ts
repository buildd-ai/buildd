#!/usr/bin/env bun
/**
 * Contradiction watch for docs/design/spec-conformance.md — closes the gap
 * described in the "shift derived-ahead-of-declared spec contradictions left"
 * suggestion: PR #2352 flipped a design doc's derived status to `implemented`
 * without updating its frontmatter, but that PR's own Tier-2 CI run didn't
 * catch it (the doc's watch-set failure path didn't gate that PR the same
 * way) — so dev's tip merged red and every subsequent PR had to independently
 * diagnose a contradiction it didn't cause (see the `7eaaf6f9` dev-tip-red
 * gotcha). Blocking the introducing PR outright would need per-PR symbol-diff
 * attribution; this is the lighter alternative named as an option in that
 * suggestion: on push to dev, diff the freshly evaluated contradiction set
 * against the last-recorded one (`spec-conformance-contradiction-docs`
 * keyed artifact) and auto-file a friction task the moment a NEW one shows
 * up, instead of waiting for the next PR author to notice.
 *
 * Deliberately best-effort, not a gate: this never fails the build (the
 * checker step with --fail-on-contradiction is the actual enforcement point
 * per §3) and no-ops quietly when WORKSPACE_ID/BUILDD_API_KEY are absent,
 * same posture as spec-conformance-delta-gate.ts.
 *
 * Cold start (no prior recorded set) records the current contradictions
 * without filing anything — otherwise turning this on for the first time
 * against a repo carrying pre-existing debt (see the "24 pre-existing status
 * contradictions" friction task) would flood the workspace with tasks for
 * state nobody introduced today.
 *
 * The buildd `/api/tasks` route already deduplicates `[friction] ` tasks by
 * `context.frictionSignature` server-side (one open task per signature, later
 * reports appended) — this script's own prior/current diff is what decides
 * WHEN to call it, the signature is what makes a double-call (e.g. a retried
 * step) or a second flip-flop of the same doc harmless.
 *
 * Usage:
 *   bun run scripts/spec-conformance-contradiction-watch.ts --workspace-id <uuid>
 *
 * Env: BUILDD_API_KEY (required to do anything but no-op), BUILDD_SERVER
 * (default https://buildd.dev), WORKSPACE_ID.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAllDocs, resolveConformanceConfig, type DocEvaluation } from '../packages/core/spec-conformance';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const ARTIFACT_KEY = 'spec-conformance-contradiction-docs';
const FRICTION_PRIORITY = 8;

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// Overridable for tests only — see spec-conformance-delta-gate.ts for the
// same convention.
const ROOT = argValue('--repo-root') ?? DEFAULT_ROOT;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function log(message: string) {
  console.log(`[spec-conformance-contradiction-watch] ${message}`);
}

async function getArtifact(serverUrl: string, apiKey: string, workspaceId: string): Promise<string | null> {
  const res = await fetch(`${serverUrl}/api/workspaces/${workspaceId}/artifacts?key=${ARTIFACT_KEY}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    log(`artifact lookup failed (${res.status}) — treating as cold start`);
    return null;
  }
  const data = (await res.json()) as { artifacts?: Array<{ content: string | null }> };
  return data.artifacts?.[0]?.content ?? null;
}

async function recordArtifact(serverUrl: string, apiKey: string, workspaceId: string, paths: string[]) {
  const res = await fetch(`${serverUrl}/api/workspaces/${workspaceId}/artifacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'data',
      title: ARTIFACT_KEY,
      content: JSON.stringify(paths),
      key: ARTIFACT_KEY,
    }),
  });
  if (!res.ok) {
    log(`recording contradiction set failed (${res.status}) — next run may re-alert`);
    return;
  }
  log(`recorded ${paths.length} contradiction(s) as last-known state`);
}

function parsePriorPaths(raw: string | null): Set<string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((p): p is string => typeof p === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

async function fileFrictionTask(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  evaluation: DocEvaluation,
  sha: string,
) {
  const contradiction = evaluation.contradiction!;
  const signature = `spec-conformance-contradiction:${evaluation.path}`;
  const title = `[friction] spec-conformance: new ${contradiction.kind} contradiction on dev`;
  const description = [
    `dev's tip (${sha}) carries a spec-conformance contradiction that was not present in the previously recorded state — filed automatically so the cost lands near the commit that caused it instead of on whichever unrelated PR merges dev next.`,
    '',
    `Doc: ${evaluation.path}`,
    `declared=${evaluation.declaredStatus ?? '(none)'} derived=${evaluation.derivedStatus}`,
    contradiction.message,
    '',
    'Verify with `bun run specs:conformance -- --fail-on-contradiction` and apply the fix named in the message above.',
  ].join('\n');

  try {
    const res = await fetch(`${serverUrl}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        title,
        description,
        priority: FRICTION_PRIORITY,
        context: { frictionSignature: signature, frictionExcerpt: contradiction.message },
      }),
    });
    if (!res.ok) {
      log(`filing friction task for ${evaluation.path} failed (${res.status})`);
      return;
    }
    const data = (await res.json()) as { id?: string; deduplicated?: boolean };
    log(`${data.deduplicated ? 'appended to existing' : 'filed'} friction task ${data.id ?? '(unknown id)'} for ${evaluation.path}`);
  } catch (err) {
    log(`filing friction task for ${evaluation.path} errored: ${String(err)}`);
  }
}

async function run() {
  const workspaceId = argValue('--workspace-id') ?? process.env.WORKSPACE_ID;
  const apiKey = process.env.BUILDD_API_KEY;
  const serverUrl = argValue('--server') ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev';

  if (!workspaceId || !apiKey) {
    log('WORKSPACE_ID or BUILDD_API_KEY not set — skipping');
    return;
  }

  const config = resolveConformanceConfig({ repoRoot: ROOT });
  const evaluations = evaluateAllDocs(config);
  const current = new Map(evaluations.filter((e) => e.contradiction).map((e) => [e.path, e]));

  const priorRaw = await getArtifact(serverUrl, apiKey, workspaceId);
  const priorPaths = parsePriorPaths(priorRaw);

  if (priorPaths === null) {
    log(`no prior recorded contradiction set (cold start) — recording ${current.size} without alerting`);
  } else {
    let sha = '(unknown)';
    try {
      sha = git(['rev-parse', 'HEAD']);
    } catch {
      // best-effort only — a missing/unreachable HEAD just loses the sha in the report
    }

    const newPaths = [...current.keys()].filter((p) => !priorPaths.has(p));
    if (newPaths.length === 0) {
      log(`${current.size} contradiction(s) on dev, none new since last recorded state`);
    }
    for (const path of newPaths) {
      await fileFrictionTask(serverUrl, apiKey, workspaceId, current.get(path)!, sha);
    }
  }

  await recordArtifact(serverUrl, apiKey, workspaceId, [...current.keys()]);
}

try {
  await run();
} catch (err) {
  log(`unexpected error, no-oping: ${String(err)}`);
}
// fetch() keeps its keep-alive socket open past the last await, which would
// otherwise hang the process — see spec-conformance-delta-gate.ts.
process.exit(0);
