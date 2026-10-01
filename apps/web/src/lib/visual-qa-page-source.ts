/**
 * Server half of the visual auditor's page source (docs/design/visual-qa-auditor.md,
 * "Page source"): reads the commit's GitHub deployments with the workspace's
 * GitHub App token and hands them to the pure resolver in
 * @buildd/core/visual-qa-page-source. No Vercel credential is involved, and no
 * secret value is read: only whether the bypass/storage-state env names are mapped.
 */
import {
  resolveVisualQaConfig,
  resolvePreviewUrl,
  selectPageSource,
  STORAGE_STATE_ENV,
  VERCEL_BYPASS_ENV,
  type PageSourceDecision,
  type PreviewResolution,
  type ResolvedVisualQaConfig,
} from '@buildd/core/visual-qa-page-source';

/** GET against the GitHub REST API as the workspace's installation. Throws on non-2xx. */
export type GitHubGet = (path: string) => Promise<unknown>;

/** Hard ceiling on one call's long-poll; Vercel functions cannot hold longer. */
export const MAX_PAGE_SOURCE_WAIT_SECONDS = 45;
const POLL_MS = 5_000;

export interface PageSourceResult {
  pageSource: ResolvedVisualQaConfig['pageSource'];
  sha: string | null;
  preview: PreviewResolution | null;
  decision: PageSourceDecision;
  /** Env var names the capture reads; `mapped` says whether gitConfig.envMapping names each. */
  auth: {
    protectionBypass: { env: string; mapped: boolean };
    storageState: { env: string; mapped: boolean };
    previewAuthBypassEnv: string;
    signInPaths: string[];
  };
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // githubApi puts the response body in the message; keep the status line only.
  return m.split('\n')[0].slice(0, 200);
}

async function resolveSha(get: GitHubGet, repo: string, input: { sha?: string | null; prNumber?: number | null; ref?: string | null }): Promise<string> {
  if (input.sha) {
    if (!HEX_SHA.test(input.sha)) throw new Error('sha must be a hex commit id');
    if (input.sha.length === 40) return input.sha.toLowerCase();
  }
  if (input.prNumber) {
    const pr = await get(`/repos/${repo}/pulls/${input.prNumber}`) as { head?: { sha?: string } };
    if (!pr?.head?.sha) throw new Error(`PR #${input.prNumber} has no head commit`);
    return pr.head.sha;
  }
  const ref = input.sha ?? input.ref ?? 'HEAD';
  const commit = await get(`/repos/${repo}/commits/${encodeURIComponent(ref)}`) as { sha?: string };
  if (!commit?.sha) throw new Error(`could not resolve ${ref} to a commit`);
  return commit.sha;
}

export async function resolvePageSource(opts: {
  get: GitHubGet | null;
  repoFullName: string | null;
  gitConfig: { visualQa?: unknown; envMapping?: Record<string, string>; defaultBranch?: string } | null | undefined;
  sha?: string | null;
  prNumber?: number | null;
  waitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<PageSourceResult> {
  const config = resolveVisualQaConfig(opts.gitConfig?.visualQa);
  const envMapping = opts.gitConfig?.envMapping ?? {};
  const auth = {
    protectionBypass: { env: VERCEL_BYPASS_ENV, mapped: !!envMapping[VERCEL_BYPASS_ENV] },
    storageState: { env: STORAGE_STATE_ENV, mapped: !!envMapping[STORAGE_STATE_ENV] },
    previewAuthBypassEnv: config.previewAuthBypassEnv,
    signInPaths: config.signInPaths,
  };

  if (config.pageSource === 'sandbox') {
    return { pageSource: 'sandbox', sha: null, preview: null, decision: selectPageSource('sandbox', null), auth };
  }

  const get = opts.get;
  const repo = opts.repoFullName;
  let sha: string | null = null;
  let preview: PreviewResolution;
  if (!get || !repo) {
    preview = { state: 'unreadable', reason: 'the workspace has no GitHub App installation for its repo' };
  } else {
    try {
      sha = await resolveSha(get, repo, { sha: opts.sha, prNumber: opts.prNumber, ref: opts.gitConfig?.defaultBranch ?? null });
      const wait = Math.max(0, Math.min(opts.waitSeconds ?? 0, MAX_PAGE_SOURCE_WAIT_SECONDS));
      preview = await resolvePreviewUrl(
        {
          listDeployments: async (s) => (await get(`/repos/${repo}/deployments?sha=${s}&per_page=30`) as any[]) ?? [],
          listStatuses: async (id) => (await get(`/repos/${repo}/deployments/${id}/statuses?per_page=30`) as any[]) ?? [],
        },
        {
          sha,
          environment: config.previewEnvironment,
          timeoutMs: wait * 1000,
          pollMs: POLL_MS,
          maxDeploymentAgeMs: config.previewWaitSeconds * 1000,
          sleep: opts.sleep,
          now: opts.now,
        },
      );
    } catch (err) {
      const msg = errMessage(err);
      preview = {
        state: 'unreadable',
        reason: /\b403\b/.test(msg)
          ? `${msg} (the buildd GitHub App needs the Deployments: read permission on this repo)`
          : msg,
      };
    }
  }

  return { pageSource: config.pageSource, sha, preview, decision: selectPageSource(config.pageSource, preview), auth };
}
