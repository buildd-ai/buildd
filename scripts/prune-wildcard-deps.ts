#!/usr/bin/env bun
/**
 * Prune dependsOn edges that only exist because of the repo-wide wildcard.
 *
 * Background
 * ----------
 * Mission tasks filed without an explicit pathManifest used to default to the
 * repo-wide sentinel ['**'], and the auto-dependsOn pass in POST /api/tasks
 * (plus its twin in lib/conflict-retry.ts) used pathsOverlap(), which reports
 * TRUE whenever either side contains '**'. Every manifest-less mission task
 * therefore inherited a permanent, stored dependsOn edge to every task alive in
 * the workspace at its creation moment — creation-order FIFO wearing a
 * dependency costume, rendered as a wall of BLOCKED rows.
 *
 * The claim-time gates never honoured those edges' premise: findBlockingPr()
 * returns null for a '**' candidate and skips '**' siblings, and the
 * path_claims layer-2 backstop skips '**' as "advisory-only". A stored edge, by
 * contrast, blocks until the upstream task is completed AND its PR merged
 * (workers/claim/deps-gate.ts). Authoring now uses shouldSerializeByManifest(),
 * which refuses to mint an edge when either manifest is wildcard-scoped. This
 * script cleans up the edges written before that fix.
 *
 * What it prunes
 * --------------
 * For every task in pending | assigned | in_progress, an edge dependent → dep
 * is pruned only when BOTH hold:
 *   1. at least one side's path_manifest carries the '**' sentinel, AND
 *   2. the two manifests do NOT overlap once the sentinel is stripped out
 *      (concreteOverlap() === false).
 * Any edge a concrete-path overlap justifies is left alone. Note this is
 * deliberately MORE conservative than the authoring rule in
 * shouldSerializeByManifest(): authoring refuses an edge whenever a sentinel is
 * present at all, whereas this script keeps such an edge if the concrete
 * remainder genuinely overlaps (e.g. a manifest extended mid-task by
 * check_path_claim, which keeps its original '**' entry). Pruning less is the
 * safe direction — a surviving edge costs latency, a wrongly deleted one costs
 * correctness.
 *
 * Explicit-intent heuristic
 * -------------------------
 * The DB does not record whether an edge was caller-supplied or inferred. To
 * avoid deleting a human/organizer-authored edge, an edge is KEPT when the
 * dependent task's title/description/context mentions the dependency's UUID
 * (full or 8-char short form) — the shape the prose-gate lint expects, e.g.
 * "Gated on the spec (b984dedf) merging". Reported as "kept (explicit)".
 * Anything the heuristic cannot vouch for is listed in full in the dry-run
 * output so an operator can eyeball it before applying.
 *
 * Usage
 * -----
 *   DATABASE_URL='postgres://…prod…' bun run scripts/prune-wildcard-deps.ts
 *   DATABASE_URL='postgres://…prod…' bun run scripts/prune-wildcard-deps.ts --apply
 *
 * Flags:
 *   --apply               actually write (default is dry-run — nothing is written)
 *   --workspace <uuid>    restrict to one workspace
 *   --verbose             print every kept edge too, not just pruned ones
 *
 * DATABASE_URL is read from the environment and is supplied by the operator.
 * The repo's local .env points at a stale Neon branch — pull a prod URL
 * (`vercel env pull`) before running; this script never picks a default.
 *
 * Writes use an optimistic-lock UPDATE (CAS on the exact depends_on value read),
 * so a concurrent edit is reported as "skipped (changed under us)" rather than
 * clobbered. No transactions — the neon-http driver does not support them.
 */

import { neon } from '@neondatabase/serverless';
import { isAdvisoryManifest, pathsOverlap, REPO_WIDE_SENTINEL } from '../packages/core/path-overlap';

// ─── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERBOSE = argv.includes('--verbose');
const workspaceFlagIdx = argv.indexOf('--workspace');
const WORKSPACE_ID = workspaceFlagIdx >= 0 ? argv[workspaceFlagIdx + 1] : null;

if (workspaceFlagIdx >= 0 && !WORKSPACE_ID) {
  console.error('ERROR: --workspace requires a workspace UUID');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set — supply a production connection string');
  process.exit(1);
}
try {
  new URL(DATABASE_URL);
} catch {
  console.error('ERROR: DATABASE_URL is not a valid URL');
  process.exit(1);
}

const ACTIVE_STATUSES = ['pending', 'assigned', 'in_progress'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  status: string;
  workspace_id: string;
  path_manifest: string[] | null;
  depends_on: string[] | null;
  description: string | null;
  context: unknown;
}

interface DepRow {
  id: string;
  title: string;
  status: string;
  path_manifest: string[] | null;
}

type EdgeVerdict =
  | { action: 'keep'; reason: 'concrete-overlap' | 'no-wildcard' | 'explicit' | 'dangling' }
  | { action: 'prune'; reason: 'wildcard-only' };

// ─── Edge classification (pure) ──────────────────────────────────────────────

/**
 * Decide the fate of a single dependent → dep edge.
 *
 * Exported for testability; kept in this file because it is script-local policy
 * (the authoring-time rule itself lives in packages/core/path-overlap.ts).
 */
export function classifyEdge(params: {
  dependentManifest: string[] | null;
  dependentText: string;
  dep: DepRow | undefined;
}): EdgeVerdict {
  const { dependentManifest, dependentText, dep } = params;

  // Unknown dependency id — never touch it; a dangling edge is a different bug.
  if (!dep) return { action: 'keep', reason: 'dangling' };

  const depManifest = dep.path_manifest;

  // No wildcard anywhere → this edge cannot be a wildcard artefact.
  if (!isAdvisoryManifest(dependentManifest) && !isAdvisoryManifest(depManifest)) {
    return { action: 'keep', reason: 'no-wildcard' };
  }

  // A genuine concrete overlap justifies the edge regardless of any wildcard
  // riding along in either manifest.
  if (concreteOverlap(dependentManifest, depManifest)) {
    return { action: 'keep', reason: 'concrete-overlap' };
  }

  // Looks author-supplied: the dependent names this dep explicitly.
  if (mentionsDependency(dependentText, dep.id)) {
    return { action: 'keep', reason: 'explicit' };
  }

  return { action: 'prune', reason: 'wildcard-only' };
}

/**
 * Overlap of the two manifests with the repo-wide sentinel stripped out — i.e.
 * "do these tasks genuinely share a concrete path?".
 */
export function concreteOverlap(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  const strip = (m: string[] | null | undefined) =>
    (m ?? []).filter((p) => p !== REPO_WIDE_SENTINEL);
  return pathsOverlap(strip(a), strip(b));
}

/** True when `text` references the dependency by full UUID or 8-char short id. */
export function mentionsDependency(text: string, depId: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes(depId.toLowerCase())) return true;
  const short = depId.slice(0, 8).toLowerCase();
  // Require the short id to stand alone (not a fragment of a longer hex run).
  return new RegExp(`(^|[^0-9a-f])${short}([^0-9a-f]|$)`).test(lower);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

const short = (id: string) => id.slice(0, 8);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const manifestStr = (m: string[] | null) =>
  !m || m.length === 0 ? '(none)' : trunc(m.join(', '), 60);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sql = neon(DATABASE_URL!);

  // Bun auto-loads .env, and this repo's .env points at a stale Neon branch —
  // always show which database we actually reached so an operator can abort.
  const target = new URL(DATABASE_URL!);
  console.log(`Target: ${target.hostname}${target.pathname}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  if (WORKSPACE_ID) console.log(`Workspace filter: ${WORKSPACE_ID}`);
  console.log('');

  const tasks = (WORKSPACE_ID
    ? await sql`
        SELECT id, title, status, workspace_id, path_manifest, depends_on, description, context
        FROM tasks
        WHERE status = ANY(${ACTIVE_STATUSES})
          AND workspace_id = ${WORKSPACE_ID}::uuid
          AND depends_on IS NOT NULL
          AND jsonb_typeof(depends_on) = 'array'
          AND jsonb_array_length(depends_on) > 0
        ORDER BY created_at ASC
      `
    : await sql`
        SELECT id, title, status, workspace_id, path_manifest, depends_on, description, context
        FROM tasks
        WHERE status = ANY(${ACTIVE_STATUSES})
          AND depends_on IS NOT NULL
          AND jsonb_typeof(depends_on) = 'array'
          AND jsonb_array_length(depends_on) > 0
        ORDER BY created_at ASC
      `) as TaskRow[];

  if (tasks.length === 0) {
    console.log('No active tasks carry dependsOn edges — nothing to do.');
    return;
  }

  // Resolve every referenced dependency (any status — deps are often completed).
  const allDepIds = [...new Set(tasks.flatMap((t) => t.depends_on ?? []))];
  const depIds = allDepIds.filter((id) => UUID_RE.test(id));
  const malformed = allDepIds.filter((id) => !UUID_RE.test(id));
  if (malformed.length > 0) {
    console.log(`NOTE: ${malformed.length} dependsOn entries are not valid UUIDs — left untouched: ${malformed.join(', ')}`);
  }
  const depRows = (await sql`
    SELECT id, title, status, path_manifest
    FROM tasks
    WHERE id = ANY(${depIds}::uuid[])
  `) as DepRow[];
  const depById = new Map(depRows.map((d) => [d.id, d]));

  let totalBefore = 0;
  let totalAfter = 0;
  let tasksChanged = 0;
  let tasksWritten = 0;
  let tasksSkipped = 0;
  const keptReasons: Record<string, number> = {};

  for (const task of tasks) {
    const edges = task.depends_on ?? [];
    const dependentText = [
      task.title,
      task.description ?? '',
      task.context ? JSON.stringify(task.context) : '',
    ].join('\n');

    const kept: string[] = [];
    const pruned: Array<{ depId: string; dep: DepRow | undefined }> = [];
    const keptDetail: Array<{ depId: string; reason: string }> = [];

    for (const depId of edges) {
      const dep = depById.get(depId);
      const verdict = classifyEdge({
        dependentManifest: task.path_manifest,
        dependentText,
        dep,
      });
      if (verdict.action === 'prune') {
        pruned.push({ depId, dep });
      } else {
        kept.push(depId);
        keptDetail.push({ depId, reason: verdict.reason });
        keptReasons[verdict.reason] = (keptReasons[verdict.reason] ?? 0) + 1;
      }
    }

    totalBefore += edges.length;
    totalAfter += kept.length;

    if (pruned.length === 0) {
      if (VERBOSE) {
        console.log(
          `· ${short(task.id)} ${trunc(task.title, 58).padEnd(58)} ${String(edges.length).padStart(2)} → ${String(kept.length).padStart(2)}  (unchanged)`,
        );
      }
      continue;
    }

    tasksChanged++;
    console.log(
      `${short(task.id)} ${trunc(task.title, 58).padEnd(58)} ${String(edges.length).padStart(2)} → ${String(kept.length).padStart(2)}  (-${pruned.length})`,
    );
    console.log(`    manifest: ${manifestStr(task.path_manifest)}`);
    for (const p of pruned) {
      console.log(
        `    - prune ${short(p.depId)} [${p.dep?.status ?? '?'}] ${trunc(p.dep?.title ?? '(unknown)', 44)}` +
          `  manifest: ${manifestStr(p.dep?.path_manifest ?? null)}`,
      );
    }
    if (VERBOSE) {
      for (const k of keptDetail) {
        console.log(`    = keep  ${short(k.depId)} (${k.reason})`);
      }
    }

    if (APPLY) {
      // Optimistic lock: only write if depends_on is byte-identical to what we read.
      const updated = (await sql`
        UPDATE tasks
        SET depends_on = ${JSON.stringify(kept)}::jsonb,
            updated_at = now()
        WHERE id = ${task.id}::uuid
          AND depends_on = ${JSON.stringify(edges)}::jsonb
        RETURNING id
      `) as Array<{ id: string }>;
      if (updated.length === 1) {
        tasksWritten++;
      } else {
        tasksSkipped++;
        console.log(`    ! skipped (depends_on changed under us) — re-run to retry`);
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  const wildcardTasks = tasks.filter((t) => isAdvisoryManifest(t.path_manifest)).length;

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Active tasks with edges : ${tasks.length}`);
  console.log(`  of which wildcard-scoped ('**' manifest): ${wildcardTasks}`);
  console.log(`Edges before            : ${totalBefore}` +
    ` (avg ${(totalBefore / tasks.length).toFixed(1)}/task)`);
  console.log(`Edges after             : ${totalAfter}` +
    ` (avg ${(totalAfter / tasks.length).toFixed(1)}/task)`);
  console.log(`Edges pruned            : ${totalBefore - totalAfter}`);
  console.log(`Tasks affected          : ${tasksChanged}`);
  const keptSummary = Object.entries(keptReasons)
    .map(([r, n]) => `${r}=${n}`)
    .join(', ');
  console.log(`Edges kept by reason    : ${keptSummary || '(none)'}`);
  if (APPLY) {
    console.log(`Tasks written           : ${tasksWritten}`);
    if (tasksSkipped > 0) console.log(`Tasks skipped (CAS)     : ${tasksSkipped}`);
  } else {
    console.log('');
    console.log('DRY RUN — nothing was written. Re-run with --apply to commit these changes.');
  }
}

// Only run when invoked directly, so the pure helpers stay importable in tests.
if (import.meta.main) {
  main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
  });
}
