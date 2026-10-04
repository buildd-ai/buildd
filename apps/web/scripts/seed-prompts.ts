/**
 * Deploy step: seed the `prompts` table from a deployment's own prompts
 * directory (format: `@buildd/core/prompt-seed`). Runs in the web build right
 * after `db:migrate`, and by hand.
 *
 *   bun run apps/web/scripts/seed-prompts.ts                # from PROMPTS_REPO
 *   bun run apps/web/scripts/seed-prompts.ts --dir <path>   # from a checkout
 *   add --strict to exit non-zero when the seed is refused or cannot be read
 *
 * Source, from env:
 *   PROMPTS_REPO        owner/name of a GitHub repo holding the directory. Unset: skip.
 *   PROMPTS_REPO_REF    branch, tag or sha (default: main)
 *   PROMPTS_REPO_TOKEN  optional token with contents read on that repo. Unset: the
 *                       deployment's GitHub App (GITHUB_APP_ID + its private key)
 *                       mints a read-only installation token for that one repo.
 *
 * Without a source, a token or a database this logs one line and exits 0: a
 * deployment without its own prompts runs on the public defaults, and the
 * deploy never fails for want of them. Logs carry ids, versions and counts,
 * never prompt text.
 */
import {
  PromptSeedError,
  dirPromptReader,
  githubPromptReader,
  loadPromptSeed,
  planPromptSeed,
  summarizePromptSeed,
  type ExistingPromptRow,
  type PromptFileReader,
  type PromptSeedAction,
  type PromptSeedMarker,
} from '@buildd/core/prompt-seed';
import type { RegisteredPrompt } from '@buildd/core/prompts';

export type SeedOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'refused'; problems: string[] }
  | { status: 'failed'; reason: string }
  | { status: 'seeded'; summary: string; ids: string[] };

export interface SeedDeps {
  env: Record<string, string | undefined>;
  dir?: string;
  catalog: () => RegisteredPrompt[];
  /** Mint a read token for `repo` from the GitHub App; null when the App is not configured or not installed there. */
  appToken: (repo: string) => Promise<string | null>;
  readRows: () => Promise<ExistingPromptRow[]>;
  apply: (actions: readonly PromptSeedAction[]) => Promise<void>;
  writeMarker: (marker: PromptSeedMarker) => Promise<void>;
  dirReader?: (dir: string) => PromptFileReader;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function resolveReader(deps: SeedDeps): Promise<PromptFileReader | { skip: string } | { fail: string }> {
  if (deps.dir) return (deps.dirReader ?? dirPromptReader)(deps.dir);
  const repo = deps.env.PROMPTS_REPO?.trim();
  if (!repo) return { skip: 'PROMPTS_REPO is not set; public prompt defaults stay in effect' };
  if (!REPO_SHAPE.test(repo)) return { fail: 'PROMPTS_REPO must be owner/name' };
  let token = deps.env.PROMPTS_REPO_TOKEN?.trim() || null;
  if (!token) {
    try {
      token = await deps.appToken(repo);
    } catch (err) {
      return { fail: `GitHub App token for the prompts repo failed (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  if (!token) return { skip: 'no PROMPTS_REPO_TOKEN and the GitHub App cannot read the prompts repo; public prompt defaults stay in effect' };
  return githubPromptReader({ repo, ref: deps.env.PROMPTS_REPO_REF?.trim() || 'main', token, fetchImpl: deps.fetchImpl });
}

export async function runPromptSeed(deps: SeedDeps): Promise<SeedOutcome> {
  if (!deps.env.DATABASE_URL) return { status: 'skipped', reason: 'DATABASE_URL is not set' };
  const reader = await resolveReader(deps);
  if ('skip' in reader) return { status: 'skipped', reason: reader.skip };
  if ('fail' in reader) return { status: 'failed', reason: reader.fail };

  let actions: PromptSeedAction[];
  let ids: string[];
  try {
    const entries = await loadPromptSeed(reader, deps.catalog());
    actions = planPromptSeed(entries, await deps.readRows());
    ids = entries.map(e => e.id);
  } catch (err) {
    if (err instanceof PromptSeedError) return { status: 'refused', problems: err.problems };
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    await deps.apply(actions);
    await deps.writeMarker({ seededAt: (deps.now?.() ?? new Date()).toISOString(), ids });
  } catch (err) {
    return { status: 'failed', reason: `write failed (${err instanceof Error ? err.message : String(err)})` };
  }
  return { status: 'seeded', summary: summarizePromptSeed(actions), ids };
}

/** Log the outcome (no text) and return the exit code. */
export function reportPromptSeed(outcome: SeedOutcome, strict: boolean, log: (m: string) => void = console.log): number {
  const tag = '[prompts:seed]';
  switch (outcome.status) {
    case 'skipped':
      log(`${tag} skipped: ${outcome.reason}`);
      return 0;
    case 'seeded':
      log(`${tag} seeded ${outcome.ids.length} prompt(s): ${outcome.summary}`);
      return 0;
    case 'refused':
      log(`${tag} REFUSED, nothing written (${outcome.problems.length} problem(s)); the previous rows stay in effect:`);
      for (const p of outcome.problems) log(`${tag}   ${p}`);
      return strict ? 1 : 0;
    case 'failed':
      log(`${tag} FAILED, nothing written: ${outcome.reason}; the previous rows stay in effect`);
      return strict ? 1 : 0;
  }
}

/** A read-only installation token for one repo, from the deployment's GitHub App. */
async function githubAppTokenForRepo(repo: string): Promise<string | null> {
  const key = process.env.GITHUB_APP_PRIVATE_KEY_BASE64 || process.env.GITHUB_APP_PRIVATE_KEY;
  if (!process.env.GITHUB_APP_ID || !key) return null;
  const { generateAppJWT } = await import('@buildd/core/github-installation-auth');
  const jwt = generateAppJWT();
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const inst = await fetch(`https://api.github.com/repos/${repo}/installation`, { headers });
  if (inst.status === 404) return null;
  if (!inst.ok) throw new Error(`installation lookup ${inst.status}`);
  const { id } = (await inst.json()) as { id: number };
  const res = await fetch(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: { contents: 'read' } }),
  });
  if (!res.ok) throw new Error(`installation token ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : undefined;
  const [{ listPromptCatalog }, source] = await Promise.all([
    import('../src/lib/prompt-catalog'),
    import('@buildd/core/prompt-seed-source'),
  ]);
  const outcome = await runPromptSeed({
    env: process.env,
    dir,
    catalog: listPromptCatalog,
    appToken: githubAppTokenForRepo,
    readRows: source.readPromptRows,
    apply: source.applyPromptSeed,
    writeMarker: source.writePromptSeedMarker,
  });
  process.exit(reportPromptSeed(outcome, strict));
}
