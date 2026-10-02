import { entryFromFileName, type TuningFetcher, type TuningFiles, type TuningSource } from './source';

const API = 'https://api.github.com';
const TIMEOUT_MS = 5_000;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 128 * 1024;

export interface GitHubTuningFetcherDeps {
  /** Installation token able to read `owner/repo`, or null when the App has no access. */
  getToken: (repoFullName: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Reads a flat directory of tuning files from a private repo via the GitHub
 * Contents API, pinned to one commit so a bundle is never a mix of two refs.
 * Error messages carry only the status and endpoint kind, never the token or body.
 */
export function createGitHubTuningFetcher(deps: GitHubTuningFetcherDeps): TuningFetcher {
  const doFetch = deps.fetchImpl ?? fetch;

  return async (source: TuningSource) => {
    const token = await deps.getToken(`${source.owner}/${source.repo}`);
    if (!token) throw new Error('no installation token');

    const get = async (what: string, path: string, accept: string): Promise<Response> => {
      const res = await doFetch(`${API}/repos/${source.owner}/${source.repo}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
      return res;
    };

    const sha = (await (await get('resolve ref', `/commits/${encodePath(source.ref)}`, 'application/vnd.github.sha')).text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('resolve ref returned a non-sha');

    const listing = (await (
      await get('list', `/contents/${encodePath(source.path)}?ref=${sha}`, 'application/vnd.github+json')
    ).json()) as Array<{ name?: unknown; type?: unknown; size?: unknown }>;
    if (!Array.isArray(listing)) throw new Error('list returned a non-directory');

    const names = listing
      .filter((f) => f.type === 'file' && typeof f.name === 'string' && typeof f.size === 'number' && f.size <= MAX_FILE_BYTES)
      .map((f) => f.name as string)
      .filter((n) => entryFromFileName(n) !== null)
      .sort()
      .slice(0, MAX_FILES);

    const files: TuningFiles = {};
    await Promise.all(
      names.map(async (name) => {
        const res = await get('read', `/contents/${encodePath(source.path)}/${encodeURIComponent(name)}?ref=${sha}`, 'application/vnd.github.raw+json');
        files[name] = await res.text();
      }),
    );

    return { version: sha.slice(0, 12), files };
  };
}
