export interface TuningSource {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export type TuningFiles = Record<string, string>;

export interface TuningFetchResult {
  version: string;
  files: TuningFiles;
}

export type TuningFetcher = (source: TuningSource) => Promise<TuningFetchResult>;

const SOURCE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^:\s]+):(\S+)$/;

/** Parses `owner/repo@ref:path`; null for anything malformed. */
export function parseTuningSource(raw: string | undefined | null): TuningSource | null {
  if (!raw) return null;
  const m = SOURCE_RE.exec(raw.trim());
  if (!m) return null;
  const path = m[4].replace(/^\/+|\/+$/g, '');
  if (!path || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return { owner: m[1], repo: m[2], ref: m[3], path };
}

const FILE_NAME_RE = /^([a-z0-9-]+)\.([a-z0-9-]+)\.(md|json)$/;

/** `role.builder.md` -> key `role:builder`; anything else is not a tuning entry. */
export function entryFromFileName(name: string): { key: string; kind: 'md' | 'json' } | null {
  const m = FILE_NAME_RE.exec(name);
  if (!m) return null;
  return { key: `${m[1]}:${m[2]}`, kind: m[3] as 'md' | 'json' };
}
