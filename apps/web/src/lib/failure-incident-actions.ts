/**
 * Failure Pattern Sentinel — the action side.
 *
 * The rule engine (`failure-pattern-sentinel.ts`) finds patterns, the store
 * (`failure-incident-store.ts`) folds them into one durable row each. This
 * module decides what to DO about an incident that just changed:
 *
 * 1. **Triage.** The rule engine's severity is a floor no model may lower. A
 *    critical floor is `page_now` by rule. Anything below may be asked the
 *    `buildd.failure_incident_triage` decision kind (through the shared
 *    decision policy, never a provider directly): `known_noise | monitor |
 *    systemic_bug | page_now`, a confidence and a stable reason code. A
 *    confident answer can raise severity. Unavailable, malformed or timed-out
 *    answers fall back to the floor, deterministically.
 * 2. **Alert on transitions, never occurrences.** critical and high are page
 *    candidates, medium → digest, low → ledger only. A candidate goes through
 *    the escalation gate (`incident-escalation.ts`): a critical incident is
 *    the owner's, one whose fix task is running is Buildd's, and the verdict
 *    is stored. A
 *    re-page needs a severity increase, the affected scope crossing the next
 *    `IMPACT_SCOPE_THRESHOLDS` tier, or a resolved incident recurring. The page
 *    is CLAIMED on the incident row (CAS on `version`, writing
 *    `lastAlertedAt` / `lastAlertSeverity`) before it is sent, so a retried or
 *    concurrent sweep cannot page twice. The cost is at-most-once: a send that
 *    fails after its claim is reported, not retried.
 * 3. **At most one fix task per incident.** A high-confidence `systemic_bug` /
 *    `page_now` (or a critical rule) files one bug, linked from the incident.
 *    Later changes update that task's context; nothing ever files a task per
 *    occurrence. Budget exhaustion and known transient infrastructure file
 *    nothing unless the model names a platform defect.
 *
 * Alert text carries structure only: pattern label, counts, first/last seen,
 * one task / PR, a deep link. Never the incident title, a signature or any
 * log text — those can hold whatever an error message held.
 *
 * `actOnIncidentResults` never throws: it runs after the ledger write on a
 * sweep, and an action failure must not undo or block the record.
 */
import type { FailureIncidentRule, FailureIncidentSeverity } from '@buildd/shared';
import {
  DECISION_FOR_SEVERITY,
  FAILURE_INCIDENT_TRIAGE_DECISIONS,
  type FailureIncidentTriageDecision,
  type FailureIncidentTriageFeatures,
} from '@buildd/core/decision-kind-failure-incident-triage';
import { maxSeverity, severityRank } from './failure-pattern-sentinel';
import {
  applyIncidentAction,
  createDbIncidentPort,
  ruleImpact,
  updateIncidentState,
  DEFAULT_MAX_UPSERT_ATTEMPTS,
  type IncidentStorePort,
  type StoredIncident,
  type UpsertIncidentResult,
} from './failure-incident-store';
import { appBaseUrl } from './app-url';

export type IncidentClassification = FailureIncidentTriageDecision;
export type IncidentDecisionSource = 'rule' | 'model' | 'fallback';

/** Severity each classification asks for. Applied as max(floor, this). */
export const CLASSIFICATION_SEVERITY: Record<IncidentClassification, FailureIncidentSeverity> = {
  known_noise: 'low',
  monitor: 'medium',
  systemic_bug: 'high',
  page_now: 'critical',
};

/** Below this a model answer is recorded but raises nothing. Matches the kind's threshold. */
export const RAISE_MIN_CONFIDENCE = 0.7;
/** A model answer must be at least this sure to file a fix task. */
export const FIX_TASK_MIN_CONFIDENCE = 0.8;
export const DEFAULT_DECISION_TIMEOUT_MS = 8_000;
/** Affected-scope tiers; crossing into a higher one re-pages an already-paged incident. */
export const IMPACT_SCOPE_THRESHOLDS = [10, 25, 50, 100] as const;

// ── triage ───────────────────────────────────────────────────────────────────

export interface IncidentDecisionAnswer {
  decision: string;
  confidence: number | null;
  reasonCode: string;
  source: IncidentDecisionSource;
}

/** Asks the decision kind. The default goes through `runBuilddDecision`. */
export type IncidentDecider = (features: FailureIncidentTriageFeatures, incident: StoredIncident) => Promise<IncidentDecisionAnswer>;

export interface IncidentTriage {
  classification: IncidentClassification;
  floorSeverity: FailureIncidentSeverity;
  /** Effective: max(floor, what a confident answer asked for). */
  severity: FailureIncidentSeverity;
  confidence: number | null;
  reasonCode: string;
  source: IncidentDecisionSource;
}

/** Counters that measure breadth, per rule. The first present wins over the affected-refs count when larger. */
const BREADTH_KEYS = ['distinctTasks', 'children', 'prs', 'stalledTasks', 'mismatchedWorkers', 'recentFailed'] as const;

/** How many distinct things the incident touches: the number impact thresholds compare. */
export function impactScope(incident: Pick<StoredIncident, 'impact' | 'affectedRefs'>): number {
  const impact = ruleImpact(incident.impact);
  let scope = incident.affectedRefs?.taskIds?.length ?? 0;
  for (const k of BREADTH_KEYS) if (typeof impact[k] === 'number' && impact[k] > scope) scope = impact[k];
  return scope;
}

export function scopeTier(scope: number): number {
  return IMPACT_SCOPE_THRESHOLDS.filter(t => scope >= t).length;
}

/**
 * Budget exhaustion and transient infrastructure, by deterministic match on a
 * failure pattern's signature. Only the rules keyed on an error signature can
 * be told apart this way; the structural rules (retry forks, stranded gates,
 * attribution) are platform behaviour by construction.
 */
const TRANSIENT_OR_BUDGET =
  /budget|quota|rate[ _-]?limit|usage[ _-]?limit|credit[ _-]?balance|insufficient[ _-]?(funds|credit)|overloaded|\b(502|503|504|529)\b|timed[ _-]?out|timeout|econnreset|etimedout|enotfound|eai_again|socket[ _-]?hang[ _-]?up|network[ _-]?error|fetch[ _-]?failed/i;
const SIGNATURE_KEYED_RULES: ReadonlySet<FailureIncidentRule> = new Set(['repeated_failure']);

export function isTransientOrBudgetPattern(incident: Pick<StoredIncident, 'rule' | 'signature' | 'title'>): boolean {
  if (!SIGNATURE_KEYED_RULES.has(incident.rule)) return false;
  return TRANSIENT_OR_BUDGET.test(incident.signature) || TRANSIENT_OR_BUDGET.test(incident.title);
}

export function incidentTriageFeatures(incident: StoredIncident): FailureIncidentTriageFeatures {
  const span = (Date.parse(incident.lastSeenAt) - Date.parse(incident.firstSeenAt)) / 60_000;
  return {
    rule: incident.rule,
    floorSeverity: incident.severity,
    occurrenceCount: incident.occurrenceCount,
    distinctTasks: impactScope(incident),
    recurrenceCount: incident.recurrenceCount,
    spanMinutes: Number.isFinite(span) && span > 0 ? Math.round(span) : 0,
    transientOrBudget: isTransientOrBudgetPattern(incident),
  };
}

const REASON_CODE = /^[a-z0-9_.:-]{1,80}$/;

function fallbackTriage(floor: FailureIncidentSeverity, reasonCode: string): IncidentTriage {
  return { classification: DECISION_FOR_SEVERITY[floor], floorSeverity: floor, severity: floor, confidence: null, reasonCode, source: 'fallback' };
}

function isWellFormed(a: unknown): a is IncidentDecisionAnswer {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (FAILURE_INCIDENT_TRIAGE_DECISIONS as readonly unknown[]).includes(x.decision)
    && (x.confidence === null || (typeof x.confidence === 'number' && x.confidence >= 0 && x.confidence <= 1))
    && typeof x.reasonCode === 'string' && REASON_CODE.test(x.reasonCode)
    && (x.source === 'rule' || x.source === 'model' || x.source === 'fallback');
}

const TIMED_OUT = Symbol('timeout');

/** Never throws. A critical floor is decided by rule; everything else may ask `decide`. */
export async function triageIncident(
  incident: StoredIncident,
  opts: { decide?: IncidentDecider | null; timeoutMs?: number } = {},
): Promise<IncidentTriage> {
  const floor = incident.severity;
  if (floor === 'critical') {
    return { classification: 'page_now', floorSeverity: floor, severity: floor, confidence: null, reasonCode: `critical_floor_${incident.rule}`, source: 'rule' };
  }
  if (!opts.decide) return fallbackTriage(floor, 'fallback_no_decider');

  let raw: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      opts.decide(incidentTriageFeatures(incident), incident),
      new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS); }),
    ]);
  } catch {
    return fallbackTriage(floor, 'fallback_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (raw === TIMED_OUT) return fallbackTriage(floor, 'fallback_timeout');
  if (!isWellFormed(raw)) return fallbackTriage(floor, 'fallback_malformed');
  // The decision policy fell back itself (disabled, low confidence, no key…): its reason, our floor.
  if (raw.source === 'fallback') return fallbackTriage(floor, raw.reasonCode);

  const classification = raw.decision as IncidentClassification;
  const confident = raw.source === 'rule' || (raw.confidence ?? 0) >= RAISE_MIN_CONFIDENCE;
  return {
    classification,
    floorSeverity: floor,
    severity: confident ? maxSeverity(floor, CLASSIFICATION_SEVERITY[classification]) : floor,
    confidence: raw.confidence,
    reasonCode: raw.reasonCode,
    source: raw.source,
  };
}

// ── alerting ─────────────────────────────────────────────────────────────────

export type AlertReason = 'opened' | 'severity_increase' | 'impact_threshold' | 'recurrence';
export type AlertChannel = 'pushover_priority' | 'pushover' | 'digest' | 'ledger';

export interface IncidentAlertPlan {
  severity: FailureIncidentSeverity;
  channel: AlertChannel;
  page: boolean;
  /** Pushover priority when paging. */
  priority: 1 | 0 | null;
  reason: AlertReason | null;
}

const CHANNEL: Record<FailureIncidentSeverity, AlertChannel> = {
  critical: 'pushover_priority',
  high: 'pushover',
  medium: 'digest',
  low: 'ledger',
};

/**
 * Pure. Whether `incident`, at effective `severity`, needs a page now — judged
 * against its durable alert state only, so the same row always plans the same.
 */
export function planIncidentAlert(incident: StoredIncident, severity: FailureIncidentSeverity): IncidentAlertPlan {
  const channel = CHANNEL[severity];
  const none: IncidentAlertPlan = { severity, channel, page: false, priority: null, reason: null };
  if (channel !== 'pushover_priority' && channel !== 'pushover') return none;
  if (incident.status === 'resolved') return none;
  const priority = severity === 'critical' ? 1 : 0;
  const page = (reason: AlertReason): IncidentAlertPlan => ({ severity, channel, page: true, priority, reason });

  const last = incident.lastAlertSeverity;
  if (!last) return page(incident.recurrenceCount > 0 ? 'recurrence' : 'opened');
  const increased = severityRank(severity) > severityRank(last);
  // A person has it: only getting worse is worth a second interruption.
  if (incident.status === 'acknowledged') return increased ? page('severity_increase') : none;
  if (incident.recurrenceCount > (incident.impact?.alertedRecurrence ?? 0)) return page('recurrence');
  if (increased) return page('severity_increase');
  if (scopeTier(impactScope(incident)) > scopeTier(incident.impact?.alertedScope ?? 0)) return page('impact_threshold');
  return none;
}

const RULE_LABEL: Record<FailureIncidentRule, string> = {
  retry_fork: 'Parallel retry children',
  lineage_multi_pr: 'Multiple PRs in one retry lineage',
  repeated_failure: 'Same failure across tasks',
  stranded_gate: 'Tasks stranded at a gate',
  path_overlap_stall: 'Path-overlap stall',
  provider_attribution_mismatch: 'Provider attribution mismatch',
  failure_rate_spike: 'Failure-rate spike',
  output_unmet_boundary: 'Output unmet at one boundary',
};

const SCOPE_UNIT: Partial<Record<FailureIncidentRule, string>> = {
  lineage_multi_pr: 'PRs',
  provider_attribution_mismatch: 'workers',
  failure_rate_spike: 'failed workers',
};

const REASON_TEXT: Record<AlertReason, string> = {
  opened: 'opened',
  severity_increase: 'escalated',
  impact_threshold: 'spreading',
  recurrence: 'recurred',
};

export function incidentRuleLabel(rule: FailureIncidentRule): string {
  return RULE_LABEL[rule] ?? rule;
}

/** The one place the incident URL is spelled. */
export function incidentDeepLink(incidentId: string, baseUrl: string = appBaseUrl()): string {
  return `${baseUrl}/app/incidents/${incidentId}`;
}

/** `2026-10-04T12:00:00.000Z` → `2026-10-04 12:00Z`. */
function shortTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : iso;
}

/** Compact alert text. Structure only — see the file header. */
export function formatIncidentAlert(
  incident: StoredIncident,
  plan: Pick<IncidentAlertPlan, 'severity' | 'reason'>,
  opts: { baseUrl?: string } = {},
): { title: string; message: string } {
  const label = incidentRuleLabel(incident.rule);
  const title = `${plan.severity.toUpperCase()} incident ${REASON_TEXT[plan.reason ?? 'opened']}: ${label}`;
  const task = incident.affectedRefs?.taskIds?.[0];
  const pr = incident.affectedRefs?.prNumbers?.[0];
  const example = [task ? `task ${task.slice(0, 8)}` : null, pr !== undefined ? `PR #${pr}` : null].filter(Boolean).join(' · ');
  const lines = [
    `Impact: ${incident.occurrenceCount} occurrences across ${impactScope(incident)} ${SCOPE_UNIT[incident.rule] ?? 'tasks'}` +
      (incident.recurrenceCount > 0 ? `, recurred ${incident.recurrenceCount}x` : ''),
    `first ${shortTime(incident.firstSeenAt)} · last ${shortTime(incident.lastSeenAt)}`,
    example ? `e.g. ${example}` : null,
    incidentDeepLink(incident.id, opts.baseUrl),
  ].filter((l): l is string => !!l);
  return { title, message: lines.join('\n') };
}

export interface IncidentAlert {
  incidentId: string;
  severity: FailureIncidentSeverity;
  priority: 1 | 0;
  reason: AlertReason;
  title: string;
  message: string;
  /** Unique per claim: the transport's own dedupe must not swallow a legitimate re-page. */
  dedupeKey: string;
  /** The incident as claimed, for the gate to read its owner and fix task. */
  incident?: StoredIncident;
}

/** Delivers a claimed page. Resolves true when delivered. */
export type IncidentAlertSender = (alert: IncidentAlert) => Promise<boolean>;

/**
 * The default sender: the escalation gate (lib/failure-incident-escalation.ts). The
 * owner is paged only when the gate's rules say the incident is theirs; the
 * verdict is stored either way.
 */
export function defaultIncidentSender(): IncidentAlertSender {
  return async alert => {
    const { createGatedIncidentSender, createDbIncidentGateDeps } = await import('./failure-incident-escalation');
    return createGatedIncidentSender(createDbIncidentGateDeps())(alert);
  };
}

/**
 * Claim the page on the row: CAS the alert state, re-planning from the row as
 * read each round, so exactly one writer claims a given transition. Returns the
 * plan and the row after the claim, or `claimed: false` with the fresh row when
 * nothing needs paging (already claimed elsewhere included).
 */
export async function claimIncidentAlert(
  port: IncidentStorePort,
  incidentId: string,
  severity: FailureIncidentSeverity,
  now: string,
  opts: { maxAttempts?: number } = {},
): Promise<{ claimed: boolean; plan: IncidentAlertPlan | null; incident: StoredIncident | null }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_UPSERT_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const row = await port.findById(incidentId);
    if (!row) return { claimed: false, plan: null, incident: null };
    const effective = maxSeverity(row.severity, severity);
    const plan = planIncidentAlert(row, effective);
    if (!plan.page) return { claimed: false, plan, incident: row };
    const next = applyIncidentAction(row, {
      type: 'alerted', severity: effective, scope: impactScope(row), recurrence: row.recurrenceCount,
    }, now);
    const swapped = await port.compareAndSwap(row.id, row.version, next);
    if (swapped) return { claimed: true, plan, incident: swapped };
  }
  throw new Error(`failure incident alert claim lost to contention ${maxAttempts} times: ${incidentId}`);
}

// ── fix tasks ────────────────────────────────────────────────────────────────

export type FixTaskSkipReason =
  | 'not_systemic'
  | 'decision_unavailable'
  | 'low_confidence'
  | 'transient_or_budget'
  | 'no_workspace'
  | 'claimed_elsewhere'
  | 'disabled';

export function shouldFileFixTask(
  incident: StoredIncident,
  triage: IncidentTriage,
): { file: true } | { file: false; reason: FixTaskSkipReason } {
  if (triage.classification !== 'systemic_bug' && triage.classification !== 'page_now') return { file: false, reason: 'not_systemic' };
  if (triage.source === 'fallback') return { file: false, reason: 'decision_unavailable' };
  if (triage.source === 'model' && (triage.confidence ?? 0) < FIX_TASK_MIN_CONFIDENCE) return { file: false, reason: 'low_confidence' };
  // The model saying "transient" or "budget" is enough to hold back; only a
  // named platform defect overrides the deterministic matcher.
  if (triage.reasonCode === 'cause_transient_infra' || triage.reasonCode === 'cause_budget_or_quota') {
    return { file: false, reason: 'transient_or_budget' };
  }
  if (isTransientOrBudgetPattern(incident) && triage.reasonCode !== 'cause_platform_defect') {
    return { file: false, reason: 'transient_or_budget' };
  }
  if (!incident.workspaceId) return { file: false, reason: 'no_workspace' };
  return { file: true };
}

export interface FixTaskDraft {
  workspaceId: string;
  title: string;
  description: string;
  priority: number;
  category: 'bug';
  context: Record<string, unknown>;
}

/** Context written to the linked task on every later change. */
export function fixTaskContextUpdate(incident: StoredIncident): Record<string, unknown> {
  return {
    failureIncidentOccurrenceCount: incident.occurrenceCount,
    failureIncidentLastSeenAt: incident.lastSeenAt,
    failureIncidentSeverity: incident.severity,
    failureIncidentRecurrenceCount: incident.recurrenceCount,
    failureIncidentScope: impactScope(incident),
  };
}

export function buildFixTaskDraft(incident: StoredIncident, triage: IncidentTriage, opts: { baseUrl?: string } = {}): FixTaskDraft {
  const label = incidentRuleLabel(incident.rule);
  const pr = incident.affectedRefs.prNumbers[0];
  const tasks = incident.affectedRefs.taskIds.slice(0, 5).map(t => `\`${t.slice(0, 8)}\``).join(', ');
  return {
    workspaceId: incident.workspaceId!,
    title: `[incident] ${label}${pr !== undefined ? ` (PR #${pr})` : ''}`.slice(0, 200),
    description: [
      `The Failure Pattern Sentinel classified a ${incident.severity} incident as \`${triage.classification}\` ` +
        `(${triage.source}${triage.confidence !== null ? `, confidence ${triage.confidence.toFixed(2)}` : ''}, \`${triage.reasonCode}\`).`,
      '',
      `- **Pattern**: ${label} — \`${incident.reasonCode}\``,
      `- **Detected as**: ${incident.title.slice(0, 200)}`,
      `- **Impact**: ${incident.occurrenceCount} occurrences across ${impactScope(incident)} ${SCOPE_UNIT[incident.rule] ?? 'tasks'}`,
      `- **First / last seen**: ${incident.firstSeenAt} / ${incident.lastSeenAt}`,
      tasks ? `- **Affected tasks**: ${tasks}` : null,
      pr !== undefined ? `- **Representative PR**: #${pr}` : null,
      `- **Incident**: ${incidentDeepLink(incident.id, opts.baseUrl)}`,
      '',
      'This is the one fix task for this incident. Later occurrences update this task\'s context ' +
        '(`failureIncident*` fields) instead of filing another. Fix the platform defect behind the pattern, ' +
        'not the individual failures.',
    ].filter((l): l is string => l !== null).join('\n'),
    priority: triage.classification === 'page_now' || incident.severity === 'critical' ? 5 : 3,
    category: 'bug',
    context: {
      failureIncidentId: incident.id,
      failureIncidentSignature: incident.signature,
      failureIncidentRule: incident.rule,
      failureIncidentClassification: triage.classification,
      failureIncidentReasonCode: triage.reasonCode,
      ...fixTaskContextUpdate(incident),
    },
  };
}

export interface FixTaskPort {
  /** A non-terminal task already filed for this incident (a sweep that died before linking). */
  findOpenByIncident(incidentId: string, workspaceId: string): Promise<string | null>;
  /** Atomic, expiring claim on the right to file. False when another sweep holds it. */
  claim(incidentId: string): Promise<boolean>;
  create(draft: FixTaskDraft): Promise<string>;
  /** Merge `update` into the task's context. */
  touch(taskId: string, update: Record<string, unknown>): Promise<void>;
}

export type FixTaskOutcome =
  | { action: 'created' | 'linked_existing' | 'updated'; taskId: string }
  | { action: 'skipped'; taskId: null; reason: FixTaskSkipReason };

async function ensureFixTask(
  port: IncidentStorePort,
  fixTasks: FixTaskPort,
  incident: StoredIncident,
  triage: IncidentTriage,
  now: string,
): Promise<FixTaskOutcome> {
  if (incident.linkedFixTaskId) {
    await fixTasks.touch(incident.linkedFixTaskId, fixTaskContextUpdate(incident));
    return { action: 'updated', taskId: incident.linkedFixTaskId };
  }
  const verdict = shouldFileFixTask(incident, triage);
  if (!verdict.file) return { action: 'skipped', taskId: null, reason: verdict.reason };
  const workspaceId = incident.workspaceId!;

  const link = async (taskId: string, action: 'created' | 'linked_existing'): Promise<FixTaskOutcome> => {
    const linked = await updateIncidentState(port, incident.id, { type: 'link_fix_task', taskId }, { now });
    // First writer wins; report whichever task the incident ended up linked to.
    const winner = linked?.linkedFixTaskId ?? taskId;
    return winner === taskId ? { action, taskId } : { action: 'updated', taskId: winner };
  };

  const orphan = await fixTasks.findOpenByIncident(incident.id, workspaceId);
  if (orphan) return link(orphan, 'linked_existing');
  if (!(await fixTasks.claim(incident.id))) return { action: 'skipped', taskId: null, reason: 'claimed_elsewhere' };
  const taskId = await fixTasks.create(buildFixTaskDraft(incident, triage));
  return link(taskId, 'created');
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface IncidentActionDeps {
  /** Default: the drizzle port. */
  port?: IncidentStorePort;
  /** Default: the shared decision policy. `null`: never ask a model (floor only). */
  decide?: IncidentDecider | null;
  /** Default: `defaultIncidentSender()` (the escalation gate). */
  send?: IncidentAlertSender;
  /** Default: the database. `null`: never file fix tasks. */
  fixTasks?: FixTaskPort | null;
  now?: () => string;
  timeoutMs?: number;
  onError?: (err: unknown, incidentId: string, step: 'triage' | 'alert' | 'send' | 'fix_task') => void;
}

export interface IncidentActionResult {
  incidentId: string;
  triage: IncidentTriage;
  /** Null when this transition did not page. */
  alert: { reason: AlertReason; severity: FailureIncidentSeverity; sent: boolean } | null;
  fixTask: FixTaskOutcome | null;
}

/**
 * Act on the incidents a sweep just wrote. Only transitions count: an
 * `unchanged` upsert is skipped without asking anything. Never throws.
 */
export async function actOnIncidentResults(
  results: ReadonlyArray<UpsertIncidentResult>,
  deps: IncidentActionDeps = {},
): Promise<IncidentActionResult[]> {
  const onError = deps.onError ?? ((err, id, step) => {
    console.error(`[failure-incidents] ${step} failed for incident ${id}:`, err);
  });
  const changed = results.filter(r => r.outcome !== 'unchanged');
  if (changed.length === 0) return [];

  let port: IncidentStorePort;
  try {
    port = deps.port ?? (await createDbIncidentPort());
  } catch (err) {
    onError(err, '(store unavailable)', 'alert');
    return [];
  }
  const decide = deps.decide === undefined ? createBuilddIncidentDecider() : deps.decide;
  const send = deps.send ?? defaultIncidentSender();
  const fixTasks = deps.fixTasks === undefined ? createDbFixTaskPort() : deps.fixTasks;
  const now = deps.now ?? (() => new Date().toISOString());

  const out: IncidentActionResult[] = [];
  for (const r of changed) {
    let incident = r.incident;
    const triage = await triageIncident(incident, { decide, timeoutMs: deps.timeoutMs });
    const result: IncidentActionResult = { incidentId: incident.id, triage, alert: null, fixTask: null };

    // The fix task first: a page for an incident Buildd is already fixing is not sent, and the gate reads that task.
    if (fixTasks) {
      try {
        result.fixTask = await ensureFixTask(port, fixTasks, incident, triage, now());
      } catch (err) {
        onError(err, incident.id, 'fix_task');
      }
    }

    try {
      const at = now();
      const claim = await claimIncidentAlert(port, incident.id, triage.severity, at);
      if (claim.incident) incident = claim.incident;
      if (claim.claimed && claim.plan?.reason && claim.plan.priority !== null) {
        const { title, message } = formatIncidentAlert(incident, claim.plan);
        result.alert = { reason: claim.plan.reason, severity: claim.plan.severity, sent: false };
        try {
          result.alert.sent = await send({
            incidentId: incident.id,
            severity: claim.plan.severity,
            priority: claim.plan.priority,
            reason: claim.plan.reason,
            title,
            message,
            dedupeKey: `failure-incident:${incident.id}:${claim.plan.reason}:${at}`,
            incident,
          });
        } catch (err) {
          onError(err, incident.id, 'send');
        }
      }
    } catch (err) {
      onError(err, incident.id, 'alert');
    }
    out.push(result);
  }
  return out;
}

// ── default ports ────────────────────────────────────────────────────────────

/**
 * The decision-policy decider: resolves the incident's team and runs
 * `buildd.failure_incident_triage` through `runBuilddDecision` (capability
 * check, the team's decision model, the ledger row). No provider code here.
 */
export function createBuilddIncidentDecider(): IncidentDecider {
  return async (features, incident) => {
    if (!incident.workspaceId) return { decision: DECISION_FOR_SEVERITY[features.floorSeverity], confidence: null, reasonCode: 'fallback_no_workspace', source: 'fallback' };
    const [{ db }, { workspaces }, { eq }, { runBuilddDecision }, { failureIncidentTriageKind }] = await Promise.all([
      import('@buildd/core/db'),
      import('@buildd/core/db/schema'),
      import('drizzle-orm'),
      import('@buildd/core/decision-policy'),
      import('@buildd/core/decision-kind-failure-incident-triage'),
    ]);
    const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, incident.workspaceId)).limit(1);
    if (!ws) return { decision: DECISION_FOR_SEVERITY[features.floorSeverity], confidence: null, reasonCode: 'fallback_no_workspace', source: 'fallback' };
    const response = await runBuilddDecision(
      failureIncidentTriageKind,
      { features, subjectRef: { type: 'failure_incident', id: incident.id } },
      { teamId: ws.teamId, workspaceId: incident.workspaceId },
    );
    return { decision: response.decision, confidence: response.confidence, reasonCode: response.reasonCode, source: response.source };
  };
}

/** How long a filing claim holds before a sweep that died mid-file can be retried. */
const FIX_TASK_CLAIM_MS = 60 * 60 * 1000;

export function createDbFixTaskPort(): FixTaskPort {
  const load = async () => {
    const [{ db }, schema, orm, shared] = await Promise.all([
      import('@buildd/core/db'),
      import('@buildd/core/db/schema'),
      import('drizzle-orm'),
      import('@buildd/shared'),
    ]);
    return { db, tasks: schema.tasks, systemCache: schema.systemCache, ...orm, TERMINAL: shared.TERMINAL_TASK_STATUSES };
  };
  return {
    async findOpenByIncident(incidentId, workspaceId) {
      const { db, tasks, and, eq, sql, notInArray, TERMINAL } = await load();
      const [row] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(
          eq(tasks.workspaceId, workspaceId),
          sql`${tasks.context}->>'failureIncidentId' = ${incidentId}`,
          notInArray(tasks.status, [...TERMINAL]),
        ))
        .limit(1);
      return row?.id ?? null;
    },
    async claim(incidentId) {
      const { db, systemCache, lt } = await load();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + FIX_TASK_CLAIM_MS);
      const claimed = await db
        .insert(systemCache)
        .values({ key: `failure-incident-fix:${incidentId}`, value: { claimedAt: now.toISOString() }, updatedAt: now, expiresAt })
        .onConflictDoUpdate({
          target: systemCache.key,
          set: { value: { claimedAt: now.toISOString() }, updatedAt: now, expiresAt },
          setWhere: lt(systemCache.expiresAt, now),
        })
        .returning({ key: systemCache.key });
      return claimed.length > 0;
    },
    async create(draft) {
      const { db, tasks } = await load();
      const [filed] = await db
        .insert(tasks)
        .values({
          workspaceId: draft.workspaceId,
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          status: 'pending',
          mode: 'execution',
          taskClass: 'work',
          // System-filed, like the other generated reports (health-watcher, ci-retry, friction).
          creationSource: 'webhook',
          category: draft.category,
          context: draft.context,
        })
        .returning({ id: tasks.id });
      const { wakeTask } = await import('./dispatch-authority');
      await wakeTask(filed.id, 'task.created');
      return filed.id;
    },
    async touch(taskId, update) {
      const { db, tasks, eq, sql } = await load();
      await db
        .update(tasks)
        .set({ context: sql`coalesce(${tasks.context}, '{}'::jsonb) || ${JSON.stringify(update)}::jsonb`, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
    },
  };
}
