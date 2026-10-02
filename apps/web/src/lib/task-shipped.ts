/**
 * The task "What shipped" record, pure half. The same contract as a mission's
 * (`mission-shipped.ts`, docs/design/mission-shipped-report.md), one task wide:
 * the task's own `complete_task` output carries `shipped: { lede, offPlan? }`,
 * and the server adds the change type from the PR diff and checks the lede.
 *
 * Stored on `tasks.result.shipped`. A later completion rewrites `result` and
 * recomputes it, so there is no staleness check to make. Safe on the client.
 */
import { buildShippedRecord, type ShippedChangeType } from '@/lib/mission-shipped';

export interface TaskShippedRecord {
  version: 1;
  /** The author's plain-language answer, or null when there is none fit to show. */
  lede: string | null;
  changeType: ShippedChangeType;
  offPlan: string[];
  /** The PR the change type was read from, when there was one. */
  prNumber: number | null;
  computedAt: string;
}

export interface BuildTaskShippedInput {
  /** `structuredOutput.shipped`, or null for a session that ended on fallback text. */
  authorShipped: unknown;
  changeType: ShippedChangeType;
  prNumber: number | null;
  sensitive: boolean;
  now: Date;
}

/**
 * The lede check, the off-plan trim and the sensitive-workspace rule are the
 * mission's, so a task lede and a mission lede pass or fail the same way.
 */
export function buildTaskShippedRecord(input: BuildTaskShippedInput): { record: TaskShippedRecord; ledeRejection: string | null } {
  const { record, ledeRejection } = buildShippedRecord({
    authorShipped: input.authorShipped,
    authorTaskId: null,
    manual: false,
    changeType: input.changeType,
    pool: [],
    sensitive: input.sensitive,
    completedAt: input.now,
  });
  return {
    ledeRejection,
    record: {
      version: 1,
      lede: record.lede,
      changeType: record.changeType,
      offPlan: record.offPlan,
      prNumber: input.prNumber,
      computedAt: input.now.toISOString(),
    },
  };
}

/** The author's `shipped` object, or null for a fallback session or none written. */
export function authorShippedOf(structuredOutput: unknown, summarySource: unknown): unknown {
  if (summarySource === 'fallback') return null;
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) return null;
  return (structuredOutput as { shipped?: unknown }).shipped ?? null;
}

/** `result.shipped` when it is a version-1 record, else null. */
export function parseTaskShippedRecord(raw: unknown): TaskShippedRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  return {
    version: 1,
    lede: typeof r.lede === 'string' && r.lede.trim() ? r.lede.trim() : null,
    changeType: r.changeType === 'frontend' || r.changeType === 'backend' || r.changeType === 'both' ? r.changeType : null,
    offPlan: Array.isArray(r.offPlan) ? r.offPlan.filter((l): l is string => typeof l === 'string').slice(0, 2) : [],
    prNumber: typeof r.prNumber === 'number' ? r.prNumber : null,
    computedAt: typeof r.computedAt === 'string' ? r.computedAt : '',
  };
}
