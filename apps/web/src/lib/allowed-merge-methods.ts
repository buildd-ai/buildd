/**
 * Which merge methods GitHub will accept for a PR into a given base, and the
 * method a door uses when its caller did not choose one.
 *
 * Two places restrict the method: the repository settings
 * (`allow_squash_merge` / `allow_merge_commit` / `allow_rebase_merge`) and any
 * ruleset `pull_request` rule on the base branch (`allowed_merge_methods`). A
 * repo can allow squash while a ruleset on `main` allows only `merge`; reading
 * the repo settings alone misses that, and the merge then fails with
 * GitHub 405 "Squash merges are not allowed on this repository" — a
 * mechanical mismatch, not a decision a person has to make.
 */
import { githubApi } from '@/lib/github';
import { integrationRefreshOf, type MergeMethod } from '@/lib/integration-refresh';

const ALL: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

interface RepoMergeSettings {
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
}

interface BranchRule {
  type?: string;
  parameters?: { allowed_merge_methods?: unknown };
}

/** The methods both the repo settings and every pull_request rule on the base allow. */
export function allowedMergeMethodsFrom(repo: RepoMergeSettings | null, rules: BranchRule[] | null): MergeMethod[] {
  let allowed = ALL.filter((m) => {
    if (!repo) return true;
    const flag = m === 'squash' ? repo.allow_squash_merge : m === 'merge' ? repo.allow_merge_commit : repo.allow_rebase_merge;
    return flag !== false;
  });
  for (const rule of rules ?? []) {
    if (rule?.type !== 'pull_request') continue;
    const methods = rule.parameters?.allowed_merge_methods;
    if (!Array.isArray(methods)) continue;
    allowed = allowed.filter((m) => methods.includes(m));
  }
  return allowed;
}

/**
 * The method to use: `preferred` when allowed, else the first allowed one in
 * squash → merge → rebase order. Unknown settings (`allowed` null) or a branch
 * that allows nothing keep `preferred`, and GitHub's answer decides.
 */
export function pickMergeMethod(allowed: readonly MergeMethod[] | null, preferred: MergeMethod = 'squash'): MergeMethod {
  if (!allowed || allowed.length === 0 || allowed.includes(preferred)) return preferred;
  return ALL.find((m) => allowed.includes(m)) ?? preferred;
}

export type AllowedMergeMethodsReader = (installationId: number, repoFullName: string, baseRef: string | null) => Promise<MergeMethod[] | null>;

/** Read the allowed methods from GitHub. Null when either read fails: the caller keeps its preference. */
export const readAllowedMergeMethods: AllowedMergeMethodsReader = async (installationId, repoFullName, baseRef) => {
  try {
    const [repo, rules] = await Promise.all([
      githubApi(installationId, `/repos/${repoFullName}`) as Promise<RepoMergeSettings>,
      baseRef
        ? (githubApi(installationId, `/repos/${repoFullName}/rules/branches/${encodeURIComponent(baseRef)}`) as Promise<BranchRule[]>)
        : Promise.resolve([] as BranchRule[]),
    ]);
    return allowedMergeMethodsFrom(repo ?? null, Array.isArray(rules) ? rules : []);
  } catch (err) {
    console.warn(`[merge-method] could not read allowed merge methods for ${repoFullName}@${baseRef ?? '?'}:`, err instanceof Error ? err.message : err);
    return null;
  }
};

/**
 * The method a merge door sends to GitHub.
 * - An integration-refresh PR is always a merge commit (integration-refresh.ts).
 * - An explicit request is the caller's; it is sent as asked.
 * - No request: squash if the base allows it, else an allowed method.
 */
export async function resolveAllowedMergeMethod(
  p: { context: unknown; requested?: MergeMethod | null; installationId: number; repoFullName: string; baseRef: string | null },
  read: AllowedMergeMethodsReader = readAllowedMergeMethods,
): Promise<MergeMethod> {
  if (integrationRefreshOf(p.context)) return 'merge';
  if (p.requested) return p.requested;
  return pickMergeMethod(await read(p.installationId, p.repoFullName, p.baseRef));
}

/** True when GitHub refused the merge because of the method alone (405 "X merges are not allowed"). */
export function isMergeMethodRefusal(message: string | null | undefined): boolean {
  return /\b(squash|merge|rebase)( commit)? merges are not allowed\b/i.test(message ?? '') || /merge method .* not allowed/i.test(message ?? '');
}
