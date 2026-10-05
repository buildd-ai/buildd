/**
 * The decisions behind the New Workspace form, kept out of the component so
 * they can be tested: what name a workspace gets, when the form can submit,
 * and how a refusal from the API is worded for the person filling it in.
 *
 * A repository is optional. A workspace with no repo is a real thing (agents
 * run in a plain folder until one is linked), so the only hard requirement is
 * a name, which a repo supplies when the person did not type one.
 */

export interface RepoInfo {
  name: string;
  fullName: string;
}

/** `owner/repo`, `https://github.com/owner/repo(.git)` or `git@host:owner/repo` → its parts. */
export function extractRepoInfo(url: string): RepoInfo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length >= 2) return { name: parts[parts.length - 1], fullName: cleaned };
  if (parts.length === 1) return { name: parts[0], fullName: parts[0] };
  return null;
}

export const NAME_REQUIRED_COPY = 'Give the workspace a name. A repository is optional.';

export type NameResolution = { ok: true; name: string } | { ok: false; error: string };

/** The typed name wins; otherwise the repo's name; otherwise the form asks for one. */
export function resolveWorkspaceName(input: { typedName: string; repoName?: string | null }): NameResolution {
  const typed = input.typedName.trim();
  if (typed) return { ok: true, name: typed };
  const fromRepo = input.repoName?.trim();
  if (fromRepo) return { ok: true, name: fromRepo };
  return { ok: false, error: NAME_REQUIRED_COPY };
}

/**
 * The API's error, reworded where it was written for an API caller. Anything
 * not recognised passes through unchanged: it is already a sentence.
 */
export function plainCreateError(status: number, apiError: string | undefined): string {
  const raw = (apiError ?? '').trim();
  if (/^name is required/i.test(raw)) return NAME_REQUIRED_COPY;
  if (status === 401) return 'Your session ended. Sign in again, then retry.';
  if (status === 403 && !raw) return 'You do not have permission to create a workspace in this team.';
  if (status >= 500 || !raw || /^failed to create workspace$/i.test(raw)) {
    return 'The workspace could not be created. Try again in a moment.';
  }
  return raw;
}
