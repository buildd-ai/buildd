/**
 * Plain words for a failure incident, and the one projection every surface
 * draws it from (docs/specs/failure-incident-recovery.md §9, §17).
 *
 * `projectIncident` turns (incident, recovery assessment, stored verdict) into
 * owner, state word, sentence, next check and typed options. The incident
 * page, Home's Needs You card, the nav badge (which counts Home's rows) and
 * the push all read it, so none of them decides ownership on its own (I-6).
 * Pure: no DB, no clock unless `now` is omitted.
 */
import type {
  FailureIncidentAffectedRefs,
  FailureIncidentRecovery,
  FailureIncidentRule,
  FailureIncidentSeverity,
  FailureIncidentStatus,
  FailureRecoveryCapability,
  FailureRecoveryOwner,
  FailureRecoveryState,
} from '@buildd/shared';
import type { EscalationVerdict } from '@buildd/core/escalation-gate';
import type { StateKey } from '@/components/ui/states';
import { formatInZone } from './zoned-time';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (id: string) => id.slice(0, 8);

function ago(from: Date, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function incidentStateLine(
  i: { severity: FailureIncidentSeverity; status: FailureIncidentStatus; occurrenceCount: number; recurrenceCount: number; firstSeenAt: Date },
  now: Date = new Date(),
): string {
  const times = i.occurrenceCount === 1 ? 'once' : `${i.occurrenceCount} times`;
  const parts = [cap(i.severity), cap(i.status), `seen ${times} since ${ago(i.firstSeenAt, now)}`];
  if (i.recurrenceCount > 0) parts.push(`came back ${i.recurrenceCount === 1 ? 'once' : `${i.recurrenceCount} times`}`);
  return parts.join(' · ');
}

const LIMIT = 10;

/** Affected work as links: a task's human title when known, else its short id. */
export function incidentAffected(refs: FailureIncidentAffectedRefs | null | undefined, titles: ReadonlyMap<string, string> = new Map()) {
  const taskIds = refs?.taskIds ?? [];
  const prNumbers = refs?.prNumbers ?? [];
  return {
    tasks: taskIds.slice(0, LIMIT).map(id => ({ id, label: titles.get(id) ?? `Task ${short(id)}`, href: `/app/tasks/${id}` })),
    moreTasks: Math.max(0, taskIds.length - LIMIT),
    prs: prNumbers.slice(0, LIMIT).map(n => ({ label: `PR #${n}` })),
  };
}

const CAUSE_TEXT: Record<string, string> = {
  'path_overlap.no_progress': 'Work is waiting on a change to the same files',
  'path_overlap.blocker_open': 'A task is waiting for a change to the same files to land',
  'path_overlap.blocker_merged_unreleased': 'A change landed but still holds its files',
  'path_overlap.blocker_stuck': 'A task is waiting on a change that stopped moving',
  'path_overlap.cycle': 'Two pieces of work are waiting on each other',
  'path_overlap.subject_exempt_violated': 'A task is held by the change it is meant to update',
  'path_overlap.spurious_overlap': 'A change claims files it does not touch',
};

/** What is wrong, as a headline: the assessment's refined cause, else the rule's label. No ids (design-system §5). */
export function incidentCause(reasonCode: string | null | undefined, rule: FailureIncidentRule, ruleLabel?: string): string {
  return (reasonCode && CAUSE_TEXT[reasonCode]) ?? ruleLabel ?? cap(rule.replace(/_/g, ' '));
}

// ── The projection ─────────────────────────────────────────────────────────

/** Rules whose incidents below critical Buildd recovers on its own: an unassessed one is never the person's. */
export const BUILDD_RECOVERED_RULES: ReadonlySet<FailureIncidentRule> = new Set(['path_overlap_stall']);

/** An assessment with no observation in this long reads as inconclusive (§5 rule 2, 2× the cron cadence). */
const STALE_MINUTES = 60;

export interface IncidentForView {
  id: string;
  status: FailureIncidentStatus;
  severity: FailureIncidentSeverity;
  rule: FailureIncidentRule;
  linkedFixTaskId: string | null;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  resolvedAt?: Date | string | null;
  recovery?: FailureIncidentRecovery | null;
}

/** A stored escalation verdict, with the assessment generation it was made on when the gate stamped one. */
export type IncidentVerdictView = EscalationVerdict & { generation?: number | null };

/** What the surface says the incident is doing. One word per §17.1 row. */
export type IncidentPhase =
  | 'checking' | 'repair_queued' | 'repair_running' | 'retrying' | 'waiting'
  | 'inconclusive' | 'unavailable' | 'decision' | 'recovered';

export type IncidentOptionMode =
  /** Posted to the click-time re-check route (`/api/health/incidents/[id]/actions`). */
  | 'post'
  /** Done where the subject lives (the PR, the task); the link goes there. */
  | 'link'
  /** No way to act on it from here; shown with the reason, never as a dead button. */
  | 'unavailable';

export interface IncidentOptionView {
  capability: FailureRecoveryCapability;
  label: string;
  effect: string;
  recommended: boolean;
  mode: IncidentOptionMode;
  href?: string;
  unavailableReason?: string;
}

export interface IncidentProjection {
  owner: FailureRecoveryOwner;
  ownerLabel: 'Buildd' | 'Operator' | 'You';
  phase: IncidentPhase;
  /** The recovery state it was drawn from; `observing` when not assessed. */
  state: FailureRecoveryState;
  stateWord: string;
  /** A display state from the one table (components/ui/states.ts). */
  pill: StateKey;
  tone: 'ok' | 'run' | 'act' | 'bad' | 'q' | 'dec';
  sentence: string;
  /** What Buildd does next, in its own words, when that is not already the sentence. */
  nextAction: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  /** The current episode's start (§5 rule 3); null when not assessed. */
  waitingSince: string | null;
  /** The one predicate Home, the badge and the push use: listed, counted and paged only when true. */
  needsYou: boolean;
  dismissed: boolean;
  generation: number | null;
  evidenceRevision: string | null;
  options: IncidentOptionView[];
}

export interface ProjectIncidentOpts {
  now?: string | Date;
  /** IANA zone for wall-clock times (the viewer's; the team's on shared surfaces). Default UTC. */
  timeZone?: string;
  /** The incident's linked fix task, when read. */
  fixTask?: { id: string; status: string } | null;
  /** A PR number's URL in the incident's repository. Absent: PR options cannot link. */
  prHref?: (prNumber: number) => string | null;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'skipped']);

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

/** `2:20 PM` today in the zone, else `Oct 11, 2:20 PM`. */
export function clockIn(value: string, now: string, tz: string): string {
  const sameDay = formatInZone(value, tz, 'date') === formatInZone(now, tz, 'date');
  return formatInZone(value, tz, sameDay ? 'time' : 'datetime-short');
}

/** Readable verdict check: the gate stamps the generation it judged; older stamps are absent (§9). */
function verdictIsCurrent(v: IncidentVerdictView | null | undefined, r: FailureIncidentRecovery | null): boolean {
  if (!v) return false;
  if (!r || v.generation == null) return true;
  return v.generation === r.generation;
}

function readRecovery(r: FailureIncidentRecovery | null | undefined): FailureIncidentRecovery | null {
  return r && r.v === 1 ? r : null;
}

function blockerWord(r: FailureIncidentRecovery): string | null {
  const b = r.blockers[0];
  if (!b) return null;
  if (b.kind === 'pr') return `PR #${b.id}`;
  if (b.kind === 'task') return `task ${short(b.id)}`;
  return null;
}

/** Attempts of the current repair in this generation (`…:a<n>` keys share a prefix). */
function attemptNumber(r: FailureIncidentRecovery): number {
  const key = r.nextAction?.key ?? '';
  const m = /:a(\d+)$/.exec(key);
  if (!m) return 0;
  const prefix = key.slice(0, key.length - m[1].length);
  return r.attempts.filter(a => a.generation === r.generation && a.key.startsWith(prefix)).length;
}

const PHASE_LOOK: Record<IncidentPhase, { pill: StateKey; tone: IncidentProjection['tone'] }> = {
  checking: { pill: 'recovering', tone: 'q' },
  repair_queued: { pill: 'queued', tone: 'q' },
  repair_running: { pill: 'fixing', tone: 'act' },
  retrying: { pill: 'fixing', tone: 'act' },
  waiting: { pill: 'blocked', tone: 'q' },
  inconclusive: { pill: 'recovering', tone: 'q' },
  unavailable: { pill: 'failed', tone: 'bad' },
  decision: { pill: 'needs_you', tone: 'dec' },
  recovered: { pill: 'landed', tone: 'ok' },
};

const OWNER_LABEL: Record<FailureRecoveryOwner, IncidentProjection['ownerLabel']> = { buildd: 'Buildd', operator: 'Operator', person: 'You' };

/**
 * The one projection (spec §9, §17.1). `needsYou` is true only for a
 * person-owned decision on the CURRENT assessment (or a critical incident),
 * with a stored person verdict that is not from an older generation, on an
 * incident nobody dismissed.
 */
export function projectIncident(
  incident: IncidentForView,
  verdict: IncidentVerdictView | null | undefined,
  opts: ProjectIncidentOpts = {},
): IncidentProjection {
  const now = iso(opts.now ?? new Date())!;
  const tz = opts.timeZone ?? 'UTC';
  const at = (t: string) => clockIn(t, now, tz);
  const r = readRecovery(incident.recovery);
  const dismissed = incident.status === 'acknowledged';
  const resolved = incident.status === 'resolved';
  const critical = incident.severity === 'critical';

  let phase: IncidentPhase;
  let owner: FailureRecoveryOwner = 'buildd';
  let sentence: string;
  let stateWord: string | null = null;
  let nextAction: string | null = null;
  let nextCheckAt: string | null = r?.nextCheckAt ?? null;
  let decisionOptions: FailureIncidentRecovery['decision'] | null = null;

  const stale = !!r && r.state !== 'recovered' && !resolved
    && (Date.parse(now) - Date.parse(r.observation.observedAt)) / 60_000 > STALE_MINUTES;

  if (resolved || r?.state === 'recovered') {
    phase = 'recovered';
    nextCheckAt = null;
    const when = iso(incident.resolvedAt) ?? r?.observation.observedAt ?? now;
    const summary = typeof r?.verification.params.summary === 'string' ? r.verification.params.summary : null;
    sentence = summary ? `Recovered at ${at(when)}: ${summary}` : `Recovered at ${at(when)}.`;
  } else if (!r) {
    // Not assessed: today's rules decide (an unassessed incident keeps the gate's answer).
    const fix = opts.fixTask ?? (incident.linkedFixTaskId ? { id: incident.linkedFixTaskId, status: 'unknown' } : null);
    if (fix && !TERMINAL.has(fix.status)) {
      phase = 'repair_running';
      sentence = `Buildd is fixing it in task ${short(fix.id)}.`;
    } else if (verdict?.owner === 'person' && !BUILDD_RECOVERED_RULES.has(incident.rule)) {
      phase = 'unavailable';
      owner = 'person';
      sentence = critical
        ? 'Automatic recovery unavailable: this is a critical platform incident, so you are told once. Dismiss it when you have looked.'
        : `Automatic recovery unavailable: Buildd has no recovery policy for this pattern${fix ? ' and its fix task has ended' : ''}. Look at the affected work, then dismiss it.`;
    } else {
      phase = 'checking';
      sentence = 'Buildd has not assessed this yet. It checks on its next sweep, within 30 minutes.';
    }
  } else if (stale || r.state === 'inconclusive' || r.state === 'observing') {
    phase = r.state === 'observing' && !stale ? 'checking' : 'inconclusive';
    if (stale) nextCheckAt = null;
    const next = nextCheckAt ? ` It checks again at ${at(nextCheckAt)}.` : ' It checks again on its next sweep.';
    sentence = phase === 'checking'
      ? `Buildd is checking the current status.${next}`
      : `Buildd couldn't confirm this is still happening.${next}`;
    nextAction = r.nextAction?.label ?? null;
  } else if (r.state === 'needs_decision') {
    phase = 'decision';
    owner = 'person';
    sentence = r.decision?.question ?? r.nextAction?.label ?? 'Buildd needs one choice from you.';
    decisionOptions = r.decision ?? null;
    nextCheckAt = null;
  } else if (r.state === 'needs_operator') {
    phase = 'unavailable';
    owner = 'operator';
    const reason = r.capabilityGap?.reason ?? 'Buildd lacks a capability to repair this';
    sentence = `Automatic recovery unavailable: ${reason.replace(/\.$/, '')}.${r.nextAction?.label ? ` ${r.nextAction.label}` : ' An operator has been told.'}`;
  } else if (r.state === 'recovering') {
    const kind = r.nextAction?.kind ?? '';
    const n = attemptNumber(r);
    if (kind === 'file_fix_task' && !incident.linkedFixTaskId) phase = 'repair_queued';
    else if (n >= 2) phase = 'retrying';
    else phase = 'repair_running';
    if (phase === 'retrying') stateWord = `Retrying (${Math.min(n, r.budget.limit)} of ${r.budget.limit})`;
    const label = r.nextAction?.label ?? 'Buildd is repairing this.';
    sentence = nextCheckAt ? `${label} Buildd checks the result at ${at(nextCheckAt)}.` : label;
  } else {
    // waiting
    phase = 'waiting';
    const what = r.nextAction?.kind === 'blocked_by_escalation' ? null : blockerWord(r);
    stateWord = what ? `Waiting for ${what}` : 'Waiting';
    const label = r.nextAction?.label ?? (what ? `Waiting for ${what} to land.` : 'Waiting on another piece of work.');
    sentence = nextCheckAt ? `${label} Buildd checks again at ${at(nextCheckAt)}.` : label;
  }

  if (dismissed && phase !== 'recovered') {
    // A dismissal is not resolution (§7): the incident is out of Needs You, Buildd keeps checking.
    owner = owner === 'person' ? 'buildd' : owner;
  }

  const WORDS: Record<IncidentPhase, string> = {
    checking: 'Checking current status',
    repair_queued: 'Repair queued',
    repair_running: 'Repair running',
    retrying: 'Retrying',
    waiting: 'Waiting',
    inconclusive: "Couldn't confirm",
    unavailable: 'Automatic recovery unavailable',
    decision: 'Needs you',
    recovered: 'Recovered',
  };

  const assessedForPerson = !!r && r.state === 'needs_decision' && r.owner === 'person';
  const personVerdict = verdict?.owner === 'person' && verdictIsCurrent(verdict, r);
  const needsYou = !resolved && !dismissed && personVerdict && (
    critical
      || (r ? assessedForPerson : !BUILDD_RECOVERED_RULES.has(incident.rule))
  );

  // What a person can choose: the assessment's typed options when it asks;
  // a dismissal when the gate gave it to them without one.
  let options: IncidentOptionView[] = [];
  if (!resolved && !dismissed) {
    if (decisionOptions && phase === 'decision') {
      options = decisionOptions.options.map(o => optionView(o, decisionOptions!.recommended === o.capability, r!, opts));
      options.sort((a, b) => Number(b.recommended) - Number(a.recommended));
    } else if (needsYou) {
      options = [optionView({ capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' }, true, r, opts)];
    }
  }

  const look = PHASE_LOOK[phase];
  return {
    owner,
    ownerLabel: OWNER_LABEL[owner],
    phase,
    state: r?.state ?? (resolved ? 'recovered' : 'observing'),
    stateWord: stateWord ?? WORDS[phase],
    pill: look.pill,
    tone: look.tone,
    sentence,
    nextAction: nextAction && nextAction !== sentence ? nextAction : null,
    nextCheckAt,
    lastCheckedAt: r?.observation.observedAt ?? null,
    waitingSince: r?.firstSeenAt ?? null,
    needsYou,
    dismissed,
    generation: r?.generation ?? null,
    evidenceRevision: r?.observation.evidenceRevision ?? null,
    options,
  };
}

/** Capabilities the click-time re-check route applies itself. The rest are done where their subject lives. */
export const POSTED_CAPABILITIES: ReadonlySet<FailureRecoveryCapability> = new Set(['dismiss', 'retry_recovery']);

function optionView(
  o: { capability: FailureRecoveryCapability; label: string; effect: string },
  recommended: boolean,
  r: FailureIncidentRecovery | null,
  opts: ProjectIncidentOpts,
): IncidentOptionView {
  const base = { capability: o.capability, label: o.label, effect: o.effect, recommended };
  if (POSTED_CAPABILITIES.has(o.capability)) return { ...base, mode: 'post' };
  const blocker = r?.blockers[0];
  const subject = r?.subjects.find(s => s.kind === 'task');
  let href: string | null = null;
  let where = '';
  switch (o.capability) {
    case 'open_blocker':
    case 'cancel_attempt':
    case 'narrow_blocker_manifest':
      if (blocker?.kind === 'pr') { href = opts.prHref?.(Number(blocker.id)) ?? null; where = `PR #${blocker.id}`; }
      else if (blocker?.kind === 'task') { href = `/app/tasks/${blocker.id}`; where = `task ${short(blocker.id)}`; }
      break;
    case 'narrow_subject_manifest':
      if (subject) { href = `/app/tasks/${subject.id}`; where = `task ${short(subject.id)}`; }
      break;
  }
  if (href) return { ...base, mode: 'link', href };
  return { ...base, mode: 'unavailable', unavailableReason: where ? `Do this on ${where}.` : 'This choice is not available from here.' };
}

/** Raw facts for the page's evidence disclosure: ids, paths and repair history, as stored. */
export function incidentEvidence(
  incident: IncidentForView & { title: string; reasonCode: string; signature?: string; occurrenceCount: number; recurrenceCount: number },
  tz = 'UTC',
): Array<[string, string | string[]]> {
  const r = readRecovery(incident.recovery);
  const t = (v: string) => formatInZone(v, tz, 'datetime-short');
  const rows: Array<[string, string | string[]]> = [
    ['Pattern', incident.title],
    ['Incident', incident.id],
    ['Seen', `${incident.occurrenceCount} times since ${t(iso(incident.firstSeenAt)!)}; came back ${incident.recurrenceCount} times`],
    ['Cause code', r?.cause.reasonCode ?? incident.reasonCode],
  ];
  if (incident.signature) rows.push(['Signature', incident.signature]);
  if (!r) return rows;
  rows.push(
    ['Assessment', `generation ${r.generation}, ${r.state}, owner ${r.owner}, from ${r.observation.source} at ${t(r.observation.observedAt)}`],
    ['Evidence revision', r.observation.evidenceRevision],
    ['Subjects', r.subjects.map(s => `${s.kind} ${s.id}`)],
    ['Blockers', r.blockers.map(b => `${b.kind} ${b.id}: ${b.state}`)],
    ['Overlapping paths', r.overlappingPaths],
    ['Repair budget', `${r.budget.spent} of ${r.budget.limit} used; deadline ${t(r.budget.deadlineAt)}`],
    ['Repairs run', r.attempts.map(a => `${t(a.at)} ${a.action} on ${a.subject.kind} ${short(a.subject.id)} (generation ${a.generation})`)],
  );
  if (r.capabilityGap) rows.push(['Capability gap', `${r.capabilityGap.capability}: ${r.capabilityGap.reason}`]);
  return rows;
}
