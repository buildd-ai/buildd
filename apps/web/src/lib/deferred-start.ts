export type StartAfter = 'budget_reset';
export type StartResolution =
  | 'explicit'
  | 'relative'
  | 'known_budget_reset'
  | 'default_budget_window'
  | null;

const RELATIVE_START_RE = /^(\d+)(m|h|d)$/;
const DEFAULT_BUDGET_WINDOW_MS = 5 * 60 * 60 * 1000;

export function laterStartAt(
  first: Date | null | undefined,
  second: Date | null | undefined,
): Date | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return first >= second ? first : second;
}

export function resolveDeferredStart(options: {
  startAt?: unknown;
  startIn?: unknown;
  startAfter?: unknown;
  knownBudgetResetAt?: Date | null;
  now?: Date;
  defaultBudgetWindowMs?: number;
}): { startAt: Date | null; resolution: StartResolution } {
  const { startAt, startIn, startAfter } = options;
  const supplied = [startAt, startIn, startAfter].filter(value => value !== undefined && value !== null);
  if (supplied.length > 1) {
    throw new Error('Provide only one of startAt, startIn, or startAfter');
  }
  if (supplied.length === 0) return { startAt: null, resolution: null };

  const now = options.now ?? new Date();
  let resolved: Date;
  let resolution: Exclude<StartResolution, null>;

  if (startAt !== undefined && startAt !== null) {
    if (typeof startAt !== 'string') throw new Error('startAt must be an ISO 8601 string');
    resolved = new Date(startAt);
    if (Number.isNaN(resolved.getTime())) throw new Error('startAt must be a valid ISO 8601 timestamp');
    resolution = 'explicit';
  } else if (startIn !== undefined && startIn !== null) {
    if (typeof startIn !== 'string') throw new Error('startIn must be a relative duration such as 45m, 3h, or 2d');
    const match = RELATIVE_START_RE.exec(startIn);
    if (!match) throw new Error('startIn must be a relative duration such as 45m, 3h, or 2d');
    const amount = Number(match[1]);
    if (amount <= 0) throw new Error('startIn must be greater than zero');
    const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
    resolved = new Date(now.getTime() + amount * unitMs);
    resolution = 'relative';
  } else {
    if (startAfter !== 'budget_reset') throw new Error('startAfter must be "budget_reset"');
    const known = options.knownBudgetResetAt;
    if (known && known > now) {
      resolved = known;
      resolution = 'known_budget_reset';
    } else {
      const configuredWindow = Number(process.env.DEFAULT_BUDGET_WINDOW_MS);
      const fallbackWindow = Number.isFinite(configuredWindow) && configuredWindow > 0
        ? configuredWindow
        : DEFAULT_BUDGET_WINDOW_MS;
      resolved = new Date(now.getTime() + (options.defaultBudgetWindowMs ?? fallbackWindow));
      resolution = 'default_budget_window';
    }
  }

  if (resolved <= now) throw new Error('startAt must be in the future');
  return { startAt: resolved, resolution };
}
