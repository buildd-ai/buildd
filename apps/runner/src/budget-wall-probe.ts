/**
 * Probe a provider wall (spec: a recorded wall can outlive the limit).
 *
 * A limit error records a wall and the server holds claims until the reset time
 * the provider quoted. Capacity can return earlier (a plan upgrade, another
 * account, a top-up) and only this machine can see its login. So while a wall
 * is up the runner makes a minimal authenticated call every few minutes:
 *
 *   - it succeeds   -> report `capacity`; the server clears the wall and the
 *                      runner claims again at once.
 *   - limit error   -> report `limited` with the reset time that error quotes;
 *                      the wall stays.
 *   - anything else -> report `error`; nothing changes (an outage never clears
 *                      or extends a wall).
 *
 * A cleared wall is recorded again by the next real limit error, so a mistaken
 * clear costs at most one failed attempt per slot. The probe is `sdkProbe`
 * (model-probe.ts): the same launch a worker makes, on this machine's own login.
 *
 * Triggers: the interval (`auto`), `buildd budget reset` (`cli`), and a server
 * request carried on the heartbeat (`nudge`).
 */
import { extractResetTime, NEAREST_OCCURRENCE_WINDOW_MS } from '@buildd/core/reset-time';
import { isBudgetExhaustionError } from '@buildd/core/budget-error-classifier';

export type BudgetProbeTrigger = 'auto' | 'cli' | 'nudge';
export type BudgetProbeOutcome = 'capacity' | 'limited' | 'error';

/** Minutes between probes while a wall is up; BUILDD_BUDGET_PROBE_INTERVAL_MIN overrides (0 turns the automatic probe off). */
export const DEFAULT_BUDGET_PROBE_INTERVAL_MIN = 20;

export function budgetProbeIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BUILDD_BUDGET_PROBE_INTERVAL_MIN;
  const min = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return (Number.isFinite(min) && min >= 0 ? min : DEFAULT_BUDGET_PROBE_INTERVAL_MIN) * 60_000;
}

export interface ProbeClassification { outcome: BudgetProbeOutcome; resetsAt: Date | null; error: string | null }

/** What a probe result means for the wall. */
export function classifyBudgetProbe(result: { ok: boolean; error?: string | null }, now: Date = new Date()): ProbeClassification {
  if (result.ok) return { outcome: 'capacity', resetsAt: null, error: null };
  const error = result.error ?? 'probe failed';
  if (!isBudgetExhaustionError(error)) return { outcome: 'error', resetsAt: null, error };
  const resetsAt = extractResetTime(error, { now, maxAheadMs: NEAREST_OCCURRENCE_WINDOW_MS });
  return { outcome: 'limited', resetsAt: resetsAt && resetsAt > now ? resetsAt : null, error };
}

export interface BudgetProbeRun extends ProbeClassification { trigger: BudgetProbeTrigger; cleared: boolean }

export interface BudgetWallProberDeps {
  /** One minimal authenticated call on this machine's credential. */
  probe: () => Promise<{ ok: boolean; error?: string | null }>;
  /** Tell the server; resolves with how many wall records it expired. */
  report: (r: { outcome: BudgetProbeOutcome; trigger: BudgetProbeTrigger; resetsAt: string | null }) => Promise<{ cleared?: number } | void>;
  /** The wall is gone: claim again now. */
  onCleared: () => void;
  intervalMs?: number;
  now?: () => number;
}

export class BudgetWallProber {
  private resetsAtMs: number | null = null;
  private lastProbeAt = 0;
  private lastNudge: string | null = null;
  private running = false;

  constructor(private readonly deps: BudgetWallProberDeps) {}

  /** Is a wall up (as far as this runner knows)? */
  get wallResetsAt(): Date | null { return this.resetsAtMs ? new Date(this.resetsAtMs) : null; }

  /** The claim route said claims are held until `resetsAt`. */
  noteWall(resetsAt: string | Date | null | undefined): void {
    const ms = resetsAt ? new Date(resetsAt).getTime() : NaN;
    this.resetsAtMs = Number.isFinite(ms) ? ms : null;
  }

  private wallUp(): boolean {
    return this.resetsAtMs !== null && this.resetsAtMs > (this.deps.now ?? Date.now)();
  }

  /** Interval probe: at most one per interval, only while a wall is up. */
  async tick(): Promise<BudgetProbeRun | null> {
    const interval = this.deps.intervalMs ?? budgetProbeIntervalMs();
    const now = (this.deps.now ?? Date.now)();
    if (interval <= 0 || !this.wallUp() || now - this.lastProbeAt < interval) return null;
    return this.probeNow('auto');
  }

  /** The heartbeat's request value: probes once per new value, wall or not (the server may know of walls this runner has not seen). */
  async noteNudge(requestedAt: string | null | undefined): Promise<BudgetProbeRun | null> {
    if (!requestedAt || requestedAt === this.lastNudge) return null;
    this.lastNudge = requestedAt;
    return this.probeNow('nudge');
  }

  /** Probe right now (CLI, nudge, interval). One at a time; a concurrent call gets null. */
  async probeNow(trigger: BudgetProbeTrigger): Promise<BudgetProbeRun | null> {
    if (this.running) return null;
    this.running = true;
    this.lastProbeAt = (this.deps.now ?? Date.now)();
    try {
      const result = await this.deps.probe().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      const c = classifyBudgetProbe(result, new Date(this.lastProbeAt));
      let cleared = false;
      try {
        await this.deps.report({ outcome: c.outcome, trigger, resetsAt: c.resetsAt?.toISOString() ?? null });
        if (c.outcome === 'capacity') {
          cleared = true;
          this.resetsAtMs = null;
        } else if (c.outcome === 'limited' && c.resetsAt) {
          this.resetsAtMs = c.resetsAt.getTime();
        }
      } catch (err) {
        // The server did not hear it: keep the wall, the next probe tries again.
        console.warn('[budget-probe] report failed:', err instanceof Error ? err.message : err);
        return { ...c, trigger, cleared: false };
      }
      console.log(`[budget-probe] ${trigger}: ${c.outcome}${c.resetsAt ? ` (resets ${c.resetsAt.toISOString()})` : ''}`);
      if (cleared) this.deps.onCleared();
      return { ...c, trigger, cleared };
    } finally {
      this.running = false;
    }
  }
}

/** The line `buildd budget reset` prints. */
export function describeBudgetProbeRun(run: BudgetProbeRun | null): string {
  if (!run) return 'A probe is already running; try again in a moment.';
  if (run.cleared) return 'Capacity is back: the wall is cleared and held tasks are claimable now.';
  if (run.outcome === 'limited') return `Still at the limit${run.resetsAt ? `; resets ${run.resetsAt.toISOString()}` : ''}. The wall stays.`;
  return `The probe could not tell (${run.error ?? 'unknown error'}). The wall is unchanged.`;
}
