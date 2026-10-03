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
import {
  captureTrunk,
  resolveVisualQaCaptureRef,
  type CaptureRefResolution,
} from '@buildd/core/visual-qa-capture-ref';
import { missionIntegrationBase } from '@buildd/core/mission-integration';

/** GET against the GitHub REST API as the workspace's installation. Throws on non-2xx. */
export type GitHubGet = (path: string) => Promise<unknown>;

/** Hard ceiling on one call's long-poll; Vercel functions cannot hold longer. */
export const MAX_PAGE_SOURCE_WAIT_SECONDS = 45;
const POLL_MS = 5_000;

export interface PageSourceResult {
  pageSource: ResolvedVisualQaConfig['pageSource'];
  /**
   * The branch to capture: the mission's integration branch on a
   * mission-branch mission, else trunk. The sandbox dispatch takes `--ref` from
   * it, the preview commit defaults to its head, and every shot records it as
   * `qa.ref` / `qa.refSource`.
   */
  captureRef: CaptureRefResolution;
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

/**
 * The capture ref, with the integration branch's existence read live, the same
 * rule as the PR-base guard. Only a 404 counts as gone: an unreadable answer
 * keeps the integration branch, because trunk is the error this closes.
 */
async function resolveCaptureRef(
  get: GitHubGet | null,
  repo: string | null,
  mission: Parameters<typeof resolveVisualQaCaptureRef>[0]['mission'],
  trunk: string | null,
): Promise<CaptureRefResolution> {
  const integrationBase = missionIntegrationBase(mission);
  let integrationBaseMissing = false;
  if (integrationBase && get && repo) {
    try {
      await get(`/repos/${repo}/git/ref/heads/${integrationBase}`);
    } catch (err) {
      integrationBaseMissing = /GitHub API error: 404\b/.test(errMessage(err));
    }
  }
  return resolveVisualQaCaptureRef({ mission, trunk, integrationBaseMissing });
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
  gitConfig: { visualQa?: unknown; envMapping?: Record<string, string>; defaultBranch?: string; targetBranch?: string } | null | undefined;
  /** The worker's task's mission, when it has one: its integration fields. */
  mission?: Parameters<typeof resolveVisualQaCaptureRef>[0]['mission'];
  /** The repo's own default branch, the last trunk fallback. */
  repoDefaultBranch?: string | null;
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

  const get = opts.get;
  const repo = opts.repoFullName;
  const captureRef = await resolveCaptureRef(get, repo, opts.mission, captureTrunk(opts.gitConfig, opts.repoDefaultBranch));

  if (config.pageSource === 'sandbox') {
    return { pageSource: 'sandbox', captureRef, sha: null, preview: null, decision: selectPageSource('sandbox', null), auth };
  }

  let sha: string | null = null;
  let preview: PreviewResolution;
  if (!get || !repo) {
    preview = { state: 'unreadable', reason: 'the workspace has no GitHub App installation for its repo' };
  } else {
    try {
      sha = await resolveSha(get, repo, { sha: opts.sha, prNumber: opts.prNumber, ref: captureRef.ref });
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

  return { pageSource: config.pageSource, captureRef, sha, preview, decision: selectPageSource(config.pageSource, preview), auth };
}
