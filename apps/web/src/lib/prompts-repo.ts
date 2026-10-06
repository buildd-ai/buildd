/**
 * The deployment's private prompts repo (`PROMPTS_REPO`, docs/prompts.md):
 * where it is, and a read-only token for it. Shared by the deploy seed
 * (`apps/web/scripts/seed-prompts.ts`) and the prompt eval (`./prompt-evals/run.ts`).
 *
 * No `@/` imports: the seed runs as a plain bun script during the build.
 */

export const PROMPTS_REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PromptsRepoConfig {
  repo: string;
  /** The ref the deploy seed reads (default `main`). */
  ref: string;
}

/** The configured prompts repo, or null when none is (or it is malformed). */
export function promptsRepoConfig(env: Record<string, string | undefined> = process.env): PromptsRepoConfig | null {
  const repo = env.PROMPTS_REPO?.trim();
  if (!repo || !PROMPTS_REPO_SHAPE.test(repo)) return null;
  return { repo, ref: env.PROMPTS_REPO_REF?.trim() || 'main' };
}

/**
 * A read token for `repo`: `PROMPTS_REPO_TOKEN` when set, else a read-only
 * installation token from the deployment's GitHub App, scoped to that one repo.
 * Null when neither is available (App not configured, or not installed there).
 */
export async function promptsRepoToken(repo: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const explicit = env.PROMPTS_REPO_TOKEN?.trim();
  if (explicit) return explicit;
  return githubAppTokenForRepo(repo, env);
}

/** A read-only installation token for one repo, from the deployment's GitHub App. */
export async function githubAppTokenForRepo(repo: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const key = env.GITHUB_APP_PRIVATE_KEY_BASE64 || env.GITHUB_APP_PRIVATE_KEY;
  if (!env.GITHUB_APP_ID || !key) return null;
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
