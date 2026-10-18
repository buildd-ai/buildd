/**
 * The cloud runner release a server-side deploy installs: the asset
 * publish-runner-image.yml attaches to every release tag
 * (apps/cloud-runner/src/release-bundle.ts), fetched from the public GitHub
 * release, validated, and cached per tag for this instance.
 *
 * By default the release is the one this server runs (`v<package version>`),
 * so a team's runner always matches the buildd it talks to.
 * CLOUD_RUNNER_RELEASE pins another tag (a preview whose version has no
 * release yet); CLOUD_RUNNER_RELEASE_REPO points a self-hosted buildd at its
 * own fork's releases.
 */
import pkg from '../../../package.json';
import type { FetchLike } from '../cloudflare-credential-shared';
import { RELEASE_TAG_RE, parseReleaseBundle, releaseBundleAssetName, type ReleaseBundle } from '../../../../cloud-runner/src/release-bundle';
import type { LoadReleaseBundle } from './cloudflare';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The release tag this server deploys when none is named. */
export function currentCloudRunnerRelease(env: Record<string, string | undefined> = process.env): string {
  const pinned = env.CLOUD_RUNNER_RELEASE?.trim();
  if (pinned && RELEASE_TAG_RE.test(pinned)) return pinned;
  return `v${pkg.version || '0.0.0'}`;
}

export function cloudRunnerReleaseUrl(tag: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env.CLOUD_RUNNER_RELEASE_REPO?.trim();
  const repo = configured && REPO_RE.test(configured) ? configured : 'buildd-ai/buildd';
  return `https://github.com/${repo}/releases/download/${tag}/${releaseBundleAssetName(tag)}`;
}

const cache = new Map<string, ReleaseBundle>();

/** Build a loader over `fetchImpl` (tests pass a stand-in). */
export function releaseBundleLoader(fetchImpl: FetchLike = fetch, env: Record<string, string | undefined> = process.env): LoadReleaseBundle {
  return async (requested) => {
    const tag = requested ?? currentCloudRunnerRelease(env);
    const hit = cache.get(tag);
    if (hit) return { ok: true, bundle: hit };
    let res: Response;
    try {
      res = await fetchImpl(cloudRunnerReleaseUrl(tag, env), { redirect: 'follow', signal: AbortSignal.timeout(20_000) } as RequestInit);
    } catch {
      return { ok: false, error: `Could not download the cloud runner for release ${tag}. Try again.` };
    }
    if (res.status === 404) {
      return { ok: false, error: `Release ${tag} has no cloud runner bundle yet (it is attached a few minutes after a release is tagged).` };
    }
    if (!res.ok) return { ok: false, error: `Could not download the cloud runner for release ${tag} (HTTP ${res.status}).` };
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return { ok: false, error: `The cloud runner bundle for release ${tag} is not JSON.` };
    }
    const parsed = parseReleaseBundle(raw, tag);
    if (!parsed.ok) return { ok: false, error: `The cloud runner bundle for release ${tag} is unusable: ${parsed.error}.` };
    // One release per instance in practice; keep it bounded anyway.
    if (cache.size >= 2) cache.clear();
    cache.set(tag, parsed.bundle);
    return parsed;
  };
}

/** Test seam: forget cached bundles. */
export function clearReleaseBundleCache(): void {
  cache.clear();
}
