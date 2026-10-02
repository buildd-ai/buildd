import { entryFromFileName, parseTuningSource, type TuningFetcher, type TuningFetchResult } from './source';
import { runValidator, type TuningValidator } from './validators';

export const TUNING_TTL_MS = 5 * 60_000;
export const TUNING_RETRY_AFTER_FAILURE_MS = 30_000;

export interface TuningBundle {
  readonly version: string;
  readonly loadedAt: number;
  readonly entries: ReadonlyMap<string, unknown>;
}

export interface TuningDiagnostics {
  configured: boolean;
  loaded: boolean;
  version: string | null;
  keyCount: number;
  loadedAt: number | null;
  stale: boolean;
}

export interface TuningLoaderDeps {
  /** Raw `owner/repo@ref:path`; undefined means private tuning is off. */
  source: string | undefined;
  fetcher: TuningFetcher;
  now?: () => number;
  warn?: (message: string) => void;
}

function buildBundle(result: TuningFetchResult, loadedAt: number): TuningBundle {
  const entries = new Map<string, unknown>();
  for (const name of Object.keys(result.files).sort()) {
    const meta = entryFromFileName(name);
    if (!meta || entries.has(meta.key)) continue;
    if (meta.kind === 'md') {
      entries.set(meta.key, result.files[name]);
      continue;
    }
    try {
      entries.set(meta.key, JSON.parse(result.files[name]));
    } catch {
      // A malformed file simply is not an entry; callers get their public default.
    }
  }
  return { version: result.version, loadedAt, entries };
}

/**
 * Never throws. Every failure path resolves to "no bundle", and getTuning then
 * returns the caller's public default.
 */
export function createTuningLoader(deps: TuningLoaderDeps) {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const source = parseTuningSource(deps.source);

  let bundle: TuningBundle | null = null;
  let lastAttemptAt: number | null = null;
  let lastAttemptFailed = false;
  let inflight: Promise<void> | null = null;
  const warnedKeys = new Set<string>();

  function warnOnce(key: string, reason: 'unavailable' | 'invalid') {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warn(`[tuning] using public default for key=${key} reason=${reason}`);
  }

  async function refresh(): Promise<void> {
    if (!source) return;
    try {
      const result = await deps.fetcher(source);
      bundle = buildBundle(result, now());
      lastAttemptFailed = false;
    } catch {
      lastAttemptFailed = true;
    } finally {
      lastAttemptAt = now();
    }
  }

  async function ensureFresh(): Promise<void> {
    if (!source) return;
    const age = lastAttemptAt === null ? Infinity : now() - lastAttemptAt;
    const limit = lastAttemptFailed ? TUNING_RETRY_AFTER_FAILURE_MS : TUNING_TTL_MS;
    if (age < limit) return;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    await inflight;
  }

  async function loadTuningBundle(): Promise<TuningBundle | null> {
    await ensureFresh();
    return bundle;
  }

  async function getTuning<T>(key: string, publicDefault: T, validate: TuningValidator<T>): Promise<T> {
    if (!source) return publicDefault;
    const b = await loadTuningBundle();
    if (!b) {
      warnOnce(key, 'unavailable');
      return publicDefault;
    }
    if (!b.entries.has(key)) return publicDefault;
    const checked = runValidator(validate, b.entries.get(key));
    if (!checked.ok) {
      warnOnce(key, 'invalid');
      return publicDefault;
    }
    return checked.value;
  }

  function getTuningDiagnostics(): TuningDiagnostics {
    return {
      configured: source !== null,
      loaded: bundle !== null,
      version: bundle?.version ?? null,
      keyCount: bundle?.entries.size ?? 0,
      loadedAt: bundle?.loadedAt ?? null,
      stale: bundle !== null && lastAttemptFailed,
    };
  }

  return { getTuning, loadTuningBundle, getTuningDiagnostics };
}
