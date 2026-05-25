export interface CreateWatchedProjectInput {
  repo: string;
  enabled: boolean;
  vercelProjectId: string | null;
  inFlightWindowMin: number;
  prodGraceMin: number;
  roleSlug: string;
  pushoverApp: 'tasks' | 'alerts';
  releasePrFilter: { base?: string; label?: string; titlePrefix?: string };
  notes: string | null;
}

export type UpdateWatchedProjectInput = Partial<CreateWatchedProjectInput>;

const VALID_PUSHOVER_APPS = ['tasks', 'alerts'] as const;

function ensureRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !repo) throw new Error('repo is required');
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('repo must be in "owner/name" form');
  }
  return repo;
}

function ensurePositiveInt(field: string, value: unknown, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new Error(`${field} must be ${allowZero ? '>= 0' : '> 0'}`);
  }
  return value;
}

function ensurePushoverApp(value: unknown): 'tasks' | 'alerts' {
  if (value !== 'tasks' && value !== 'alerts') {
    throw new Error(`pushoverApp must be one of: ${VALID_PUSHOVER_APPS.join(', ')}`);
  }
  return value;
}

function ensureFilter(value: unknown): { base?: string; label?: string; titlePrefix?: string } {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('releasePrFilter must be an object');
  const filter = value as Record<string, unknown>;
  const out: { base?: string; label?: string; titlePrefix?: string } = {};
  if (filter.base != null) {
    if (typeof filter.base !== 'string') throw new Error('releasePrFilter.base must be a string');
    out.base = filter.base;
  }
  if (filter.label != null) {
    if (typeof filter.label !== 'string') throw new Error('releasePrFilter.label must be a string');
    out.label = filter.label;
  }
  if (filter.titlePrefix != null) {
    if (typeof filter.titlePrefix !== 'string') throw new Error('releasePrFilter.titlePrefix must be a string');
    out.titlePrefix = filter.titlePrefix;
  }
  return out;
}

export function parseCreateInput(raw: Record<string, unknown>): CreateWatchedProjectInput {
  const repo = ensureRepo(raw.repo);
  const filter = ensureFilter(raw.releasePrFilter);
  if (!filter.base) filter.base = 'main';
  return {
    repo,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    vercelProjectId: typeof raw.vercelProjectId === 'string' && raw.vercelProjectId.length > 0 ? raw.vercelProjectId : null,
    inFlightWindowMin: raw.inFlightWindowMin === undefined ? 60 : ensurePositiveInt('inFlightWindowMin', raw.inFlightWindowMin, false),
    prodGraceMin: raw.prodGraceMin === undefined ? 60 : ensurePositiveInt('prodGraceMin', raw.prodGraceMin, false),
    roleSlug: typeof raw.roleSlug === 'string' && raw.roleSlug.length > 0 ? raw.roleSlug : 'ops',
    pushoverApp: raw.pushoverApp === undefined ? 'alerts' : ensurePushoverApp(raw.pushoverApp),
    releasePrFilter: filter,
    notes: typeof raw.notes === 'string' && raw.notes.length > 0 ? raw.notes : null,
  };
}

export function parseUpdateInput(raw: Record<string, unknown>): UpdateWatchedProjectInput {
  const out: UpdateWatchedProjectInput = {};
  if (raw.repo !== undefined) out.repo = ensureRepo(raw.repo);
  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  if (raw.vercelProjectId !== undefined) {
    out.vercelProjectId = typeof raw.vercelProjectId === 'string' && raw.vercelProjectId.length > 0 ? raw.vercelProjectId : null;
  }
  if (raw.inFlightWindowMin !== undefined) out.inFlightWindowMin = ensurePositiveInt('inFlightWindowMin', raw.inFlightWindowMin, false);
  if (raw.prodGraceMin !== undefined) out.prodGraceMin = ensurePositiveInt('prodGraceMin', raw.prodGraceMin, false);
  if (raw.roleSlug !== undefined && typeof raw.roleSlug === 'string') out.roleSlug = raw.roleSlug;
  if (raw.pushoverApp !== undefined) out.pushoverApp = ensurePushoverApp(raw.pushoverApp);
  if (raw.releasePrFilter !== undefined) out.releasePrFilter = ensureFilter(raw.releasePrFilter);
  if (raw.notes !== undefined) out.notes = typeof raw.notes === 'string' ? raw.notes : null;
  if (Object.keys(out).length === 0) throw new Error('Patch must contain at least one updatable field');
  return out;
}
