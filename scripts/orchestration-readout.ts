#!/usr/bin/env bun
/**
 * Orchestration shadow readout (knowledge-base: buildd/design/conflict-aware-orchestration.md §6).
 *
 * Grades one workspace's recorded shadow decisions (creation manifest picks
 * §5a, claim hold/start §5b) against their outcome labels, splits them by
 * whole work unit into train / held-out / a later window, calibrates on train
 * and judges the rest against the deterministic baselines. Each decision
 * group gets a verdict: `insufficient_n`, `worse_than_baseline` or
 * `eligible_for_gated`. Only the last carries a threshold, and it applies
 * nothing: promotion is a reviewed code change to `ORCHESTRATION_PROMOTIONS`
 * (packages/core/orchestration-promotion.ts) carrying a cohort ceiling.
 *
 * Read-only. The output holds workspace data: it goes to stdout or to a file
 * OUTSIDE this repository (refused otherwise) and from there to the private
 * knowledge base. Never commit it.
 *
 *   bun run scripts/orchestration-readout.ts --workspace <id> --since 2026-01-01 \
 *     [--until <iso>] [--later-from <iso>] [--held-out 0.3] [--min-n 30] \
 *     [--no-mission-links] [--out /private/path/readout.json]
 *
 * Requires DATABASE_URL for the deployment whose ledger you are reading.
 */
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface ReadoutArgs {
  workspaceId: string;
  since: Date;
  until: Date;
  laterFrom: Date;
  heldOutShare: number;
  minN: number | null;
  linkMissions: boolean;
  out: string | null;
}

const isDate = (d: Date) => Number.isFinite(d.getTime());

/** Parse argv. Throws with a usage message on anything missing or malformed. */
export function parseReadoutArgs(argv: readonly string[], now: Date = new Date()): ReadoutArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const workspaceId = get('--workspace');
  if (!workspaceId) throw new Error('--workspace <id> is required');
  const sinceRaw = get('--since');
  if (!sinceRaw) throw new Error('--since <iso date> is required');
  const since = new Date(sinceRaw);
  const until = get('--until') ? new Date(get('--until')!) : now;
  if (!isDate(since) || !isDate(until) || since >= until) throw new Error('--since must be a date before --until');
  // Default later window: the last quarter of the span.
  const laterFrom = get('--later-from')
    ? new Date(get('--later-from')!)
    : new Date(until.getTime() - (until.getTime() - since.getTime()) / 4);
  if (!isDate(laterFrom) || laterFrom <= since || laterFrom >= until) throw new Error('--later-from must fall inside the window');
  const heldOut = get('--held-out') ? Number(get('--held-out')) : 0.3;
  if (!(heldOut > 0 && heldOut < 1)) throw new Error('--held-out must be a share between 0 and 1');
  const minRaw = get('--min-n');
  const minN = minRaw === undefined ? null : Number(minRaw);
  if (minN !== null && !(Number.isInteger(minN) && minN >= 1)) throw new Error('--min-n must be a positive integer');
  return {
    workspaceId,
    since,
    until,
    laterFrom,
    heldOutShare: heldOut,
    minN,
    linkMissions: !argv.includes('--no-mission-links'),
    out: get('--out') ?? null,
  };
}

/** Resolve symlinks on the longest existing prefix (the output file itself need not exist yet). */
function realish(path: string): string {
  let p = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(p), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = dirname(p);
    if (parent === p) return resolve(path);
    tail.push(basename(p));
    p = parent;
  }
}

/** True when `path` resolves inside `repoRoot`, symlinks followed: a readout must never land where it could be committed. */
export function isInsideRepo(path: string, repoRoot: string): boolean {
  const rel = relative(realish(repoRoot), realish(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function main(): Promise<void> {
  const args = parseReadoutArgs(process.argv.slice(2));
  if (args.out) {
    let root: string | null = null;
    try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { /* not in a checkout */ }
    if (root && isInsideRepo(args.out, root)) {
      throw new Error('--out is inside the repository; write the readout to a private path outside it');
    }
  }
  const { loadClaimReadoutInput, loadManifestReadoutInput } = await import('../packages/core/orchestration-readout-source');
  const { buildOrchestrationReadout } = await import('../packages/core/orchestration-readout');
  const window = { workspaceId: args.workspaceId, since: args.since, until: args.until, linkMissions: args.linkMissions };
  const [claim, manifest] = await Promise.all([loadClaimReadoutInput(window), loadManifestReadoutInput(window)]);
  const readout = await buildOrchestrationReadout({
    claim,
    manifest,
    window: { since: args.since, until: args.until },
    plan: { laterFrom: args.laterFrom, heldOutShare: args.heldOutShare, salt: args.workspaceId },
    ...(args.minN !== null ? { minN: args.minN } : {}),
  });
  const json = JSON.stringify({ workspaceId: args.workspaceId, ...readout }, null, 2);
  if (args.out) {
    await Bun.write(args.out, json);
    for (const c of readout.capabilities) console.error(`${c.capability}: ${c.verdict}`);
    console.error(`promotion: ${readout.promotion.status}; readout written (private, do not commit)`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (import.meta.main) {
  main().then(() => process.exit(0), (err) => {
    console.error(`orchestration-readout: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
}
