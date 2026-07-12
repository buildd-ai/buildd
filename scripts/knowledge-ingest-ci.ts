#!/usr/bin/env bun
/**
 * CI fallback for `full`-scope knowledge ingest jobs (KM v2 spec §3.3, A2).
 *
 * For repos with no idle runner: run this from any CI checkout of the target
 * repo with a BUILDD_API_KEY secret. It claims queued full jobs for this repo
 * via the same /api/knowledge/ingest-jobs routes the runner fleet uses and
 * streams the repo tree to the server (which chunks/embeds/upserts) — no
 * DATABASE_URL or VOYAGE_API_KEY needed in CI.
 *
 * Usage:
 *   BUILDD_API_KEY=bld_... bun run knowledge:ingest [--dir <checkout>] \
 *     [--repo owner/name] [--server https://buildd.dev] [--max-jobs 3]
 *
 * --repo defaults to the checkout's `origin` remote.
 */
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import {
  createGitRepoReader,
  createHttpIngestApi,
  runFullIngestJob,
} from '../packages/core/knowledge-store/full-ingest';

function getFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** "git@host:owner/name.git" | "https://host/owner/name" → "owner/name". */
function normalizeRepoSlug(url: string): string | null {
  const cleaned = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? cleaned.toLowerCase() : null;
}

async function main() {
  const apiKey = process.env.BUILDD_API_KEY;
  if (!apiKey) {
    console.error('[knowledge-ingest] BUILDD_API_KEY is required');
    process.exit(1);
  }
  const serverUrl = getFlag('--server') ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev';
  const dir = resolve(getFlag('--dir') ?? '.');
  const maxJobs = parseInt(getFlag('--max-jobs') ?? '3', 10);

  let repo = getFlag('--repo') ?? null;
  if (!repo) {
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir }).toString();
      repo = normalizeRepoSlug(remote);
    } catch {
      // fall through to the error below
    }
  } else {
    repo = normalizeRepoSlug(repo);
  }
  if (!repo) {
    console.error('[knowledge-ingest] could not determine repo slug — pass --repo owner/name');
    process.exit(1);
  }

  const api = createHttpIngestApi({ serverUrl, apiKey });
  let ran = 0;
  for (; ran < maxJobs; ran++) {
    const job = await api.claimJob([repo]);
    if (!job) break;
    console.log(`[knowledge-ingest] claimed job ${job.id} (${job.trigger}) @ ${job.sha ?? 'HEAD'}`);
    const reader = createGitRepoReader(dir, job.sha);
    const result = await runFullIngestJob(job, reader, api);
    console.log(`[knowledge-ingest] job ${job.id}: ${result.status}`, result.stats ?? result.error ?? '');
    if (result.status === 'error') process.exit(1);
  }
  console.log(ran === 0 ? '[knowledge-ingest] no queued full jobs for this repo' : `[knowledge-ingest] done (${ran} job${ran === 1 ? '' : 's'})`);
}

main().catch(err => {
  console.error('[knowledge-ingest] error:', err);
  process.exit(1);
});
