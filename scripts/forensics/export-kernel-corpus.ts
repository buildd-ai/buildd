#!/usr/bin/env bun
/**
 * Export recorded workflow-kernel deliveries as a sanitized JSONL replay corpus.
 *
 *   bun scripts/forensics/export-kernel-corpus.ts --db-url-file <file> --out <path outside this repo> \
 *     [--since 2026-09-01] [--limit 200] [--errors-first] [--workspace <uuid>]
 *
 * Reads workflow_deliveries, workflow_facts, workflow_transitions,
 * workflow_effects, workflow_attempts, workflow_review_rounds and gate_events
 * (plus worker_error_traces pattern counts) over the neon HTTP driver, the way
 * the app does; `.claude/skills/delivery-forensics` has the access recipe. With
 * NEON_LOCAL_FETCH_ENDPOINT set it goes through the local proxy instead (both
 * URLs must then be loopback). Read-only.
 *
 * The output is refused inside any git work tree: the corpus describes real
 * deliveries and belongs in the private knowledge base, never in this repo.
 * Sanitizing (apps/web/src/lib/workflow/testing/sanitize.ts) replaces ids,
 * repos, branches, people and SHAs with stable pseudonyms, shifts times so each
 * delivery starts at 2000-01-01, and redacts prose.
 *
 * Replay it with:
 *   KERNEL_REPLAY_CORPUS=<path> bun run test:db apps/web/tests/db/workflow-replay.test.ts
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { applyNeonLocalOverride } from '../../packages/core/db/neon-local';
import { exportCorpus, type Query } from '../../apps/web/src/lib/workflow/testing/corpus-export';

export interface CliArgs {
  dbUrlFile: string | null;
  out: string | null;
  since: string | null;
  limit: number;
  errorsFirst: boolean;
  workspace: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { dbUrlFile: null, out: null, since: null, limit: 200, errorsFirst: false, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--db-url-file') a.dbUrlFile = next();
    else if (k === '--out') a.out = next();
    else if (k === '--since') a.since = next();
    else if (k === '--limit') a.limit = Number(next());
    else if (k === '--errors-first') a.errorsFirst = true;
    else if (k === '--workspace') a.workspace = next();
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** A neon HTTP query function for `url`, through the local proxy when one is configured. */
export function neonQuery(url: string, env: Record<string, string | undefined> = process.env): Query {
  applyNeonLocalOverride({ ...env, DATABASE_URL: url });
  const sql = neon(url);
  return async (text, params = []) => (await sql.query(text, params)) as Record<string, unknown>[];
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const args = parseArgs(argv);
  if (!args.out) throw new Error('--out <path outside the repository> is required');
  // The URL comes from a file, never argv: a command line is visible to every process on the host.
  const url = args.dbUrlFile ? readFileSync(args.dbUrlFile, 'utf8').trim() : env.DATABASE_URL;
  if (!url) throw new Error('--db-url-file <file holding DATABASE_URL> (or DATABASE_URL) is required');
  const { written, out } = await exportCorpus({ query: neonQuery(url, env), out: args.out, since: args.since, limit: args.limit, errorsFirst: args.errorsFirst, workspaceId: args.workspace });
  console.log(`[export-kernel-corpus] wrote ${written} deliveries to ${out}`);
  return written > 0 ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(`[export-kernel-corpus] ${(err as Error).message}`); process.exit(1); },
  );
}
