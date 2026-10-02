import { createGitHubTuningFetcher } from './github-source';
import { createTuningLoader } from './loader';

export { createTuningLoader, TUNING_TTL_MS, TUNING_RETRY_AFTER_FAILURE_MS } from './loader';
export type { TuningBundle, TuningDiagnostics, TuningLoaderDeps } from './loader';
export { createGitHubTuningFetcher } from './github-source';
export type { GitHubTuningFetcherDeps } from './github-source';
export { parseTuningSource, entryFromFileName } from './source';
export type { TuningSource, TuningFiles, TuningFetcher, TuningFetchResult } from './source';
export { clampedInt, clampedNumber, markdownPrompt } from './validators';
export type { TuningValidator } from './validators';

type TokenProvider = (repoFullName: string) => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;

/** Server-only wiring: the web app registers how to mint a GitHub App installation token. */
export function setTuningTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

type Loader = ReturnType<typeof createTuningLoader>;
let defaultLoader: Loader | null = null;
let defaultLoaderSource: string | undefined;

// Resolved lazily so the env var is read at call time, and rebuilt if it changes.
function loader(): Loader {
  const source = process.env.BUILDD_TUNING_SOURCE || undefined;
  if (!defaultLoader || source !== defaultLoaderSource) {
    defaultLoaderSource = source;
    defaultLoader = createTuningLoader({
      source,
      fetcher: createGitHubTuningFetcher({ getToken: (repo) => tokenProvider(repo) }),
    });
  }
  return defaultLoader;
}

/**
 * Private tuning value for `key`, or `publicDefault` when the private source is
 * unset, unreachable, missing the key, or fails `validate`. Never throws.
 * Server-only: never return the result of this from a public route.
 */
export function getTuning<T>(
  key: string,
  publicDefault: T,
  validate: import('./validators').TuningValidator<T>,
): Promise<T> {
  return loader().getTuning(key, publicDefault, validate);
}

export function loadTuningBundle() {
  return loader().loadTuningBundle();
}

/** Version/sha and counts only - safe for logs and diagnostics. */
export function getTuningDiagnostics() {
  return loader().getTuningDiagnostics();
}
