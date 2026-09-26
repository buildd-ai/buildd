/**
 * The initiative card model, shared by the Initiatives list and the initiative
 * page (docs/specs/initiatives.md).
 *
 * An initiative is a container above missions, the way Linear's initiatives sit
 * above projects: a name, an owner, an optional target date, a status a person
 * sets, and its missions. Nothing here grades the initiative. Progress is
 * missions done over missions, the bar draws one segment per mission, and
 * anything that needs attention is a fact about a mission, with a link.
 *
 * Pure and client-safe. Per-mission facts come from the missions-list card
 * model (lib/mission-list-card.ts), so a mission reads the same here as on the
 * Missions tab.
 */
import type { ListCardKind, ListPhase, ListQuestion, ListTone } from './mission-list-card';

export type InitiativeStatus = 'planned' | 'active' | 'paused' | 'completed' | 'archived';

export const INITIATIVE_STATUSES: readonly InitiativeStatus[] = ['planned', 'active', 'paused', 'completed', 'archived'];

/** Statuses a person picks from. Archived stays reachable through the API only. */
export const SETTABLE_INITIATIVE_STATUSES: readonly InitiativeStatus[] = ['planned', 'active', 'paused', 'completed'];

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

export function isInitiativeStatus(value: unknown): value is InitiativeStatus {
  return typeof value === 'string' && (INITIATIVE_STATUSES as readonly string[]).includes(value);
}

// ─── Input ────────────────────────────────────────────────────────────────────

/** One child mission, already reduced by the missions-list card model. */
export interface InitiativeMissionInput {
  id: string;
  title: string;
  /** The mission row's status. Archived missions are left out entirely. */
  status: string;
  href: string;
  kind: ListCardKind;
  statusLabel: string;
  tone: ListTone;
  /** Counted tasks done / counted tasks, as the mission's own bar counts them. */
  done: number;
  total: number;
  failed: number;
  /** The mission's goal criteria, passed / total. Null when it has none. */
  criteria?: { passed: number; total: number } | null;
  question: { label: string; href: string; prompt: string } | null;
  ask: { label: string; href: string } | null;
  /** The mission's phase bar and parked question, for the initiative page. */
  phases?: ListPhase[];
  inlineQuestion?: ListQuestion | null;
}

export interface InitiativeInput {
  id: string;
  title: string;
  description: string | null;
  status: InitiativeStatus;
  /** 'YYYY-MM-DD' or null. */
  targetDate: string | null;
  owner: { name: string } | null;
  missions: InitiativeMissionInput[];
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type InitiativeSegmentState = 'done' | 'needs_you' | 'held' | 'running' | 'waiting';

export interface InitiativeSegment {
  missionId: string;
  title: string;
  href: string;
  state: InitiativeSegmentState;
  /** 0..1, the mission's tasks done over its tasks. 1 when the mission is done. */
  fill: number;
}

export interface InitiativeMissionLine {
  id: string;
  title: string;
  href: string;
  statusLabel: string;
  tone: ListTone;
  done: number;
  total: number;
  failed: number;
  /** "1 failed", or "1 unfinished" on a done mission with tasks left. Null otherwise. */
  note: string | null;
  criteria: { passed: number; total: number } | null;
  ask: { label: string; href: string } | null;
  /** Empty for a done mission: its bar says nothing its n/N does not. */
  phases: ListPhase[];
  inlineQuestion: ListQuestion | null;
  /** An open held mission: the page offers Arm on its line. */
  held: boolean;
}

export interface InitiativeFact {
  key: 'needs_you' | 'held' | 'all_done' | 'no_missions';
  text: string;
  href: string | null;
}

export interface InitiativeAction {
  kind: 'answer' | 'arm' | 'mark_completed' | 'add_mission' | 'open';
  label: string;
  /** Null for `mark_completed`: the button writes the status itself. */
  href: string | null;
  /** The mission to arm, for `arm`. */
  missionId: string | null;
}

export type InitiativeSection = 'needs_you' | 'active' | 'planned' | 'paused' | 'completed';

export interface InitiativeCardModel {
  id: string;
  title: string;
  description: string | null;
  href: string;
  status: InitiativeStatus;
  statusLabel: string;
  owner: string | null;
  target: { label: string; overdue: boolean } | null;
  progress: { done: number; total: number; tasksDone: number; tasksTotal: number };
  segments: InitiativeSegment[];
  missions: InitiativeMissionLine[];
  facts: InitiativeFact[];
  action: InitiativeAction | null;
  section: InitiativeSection;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function monthDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * "Due today", "Due in 4d", "Due Nov 10", "6d overdue". Dates are calendar
 * days in UTC, the way they are stored. A completed initiative is never overdue.
 */
export function targetDateLabel(
  targetDate: string | null | undefined,
  status: InitiativeStatus,
  now: number = Date.now(),
): { label: string; overdue: boolean } | null {
  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;
  if (status === 'completed' || status === 'archived') return { label: `Target ${monthDay(targetDate)}`, overdue: false };
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
  const days = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - today) / DAY_MS);
  if (days < 0) return { label: `${-days}d overdue`, overdue: true };
  if (days === 0) return { label: 'Due today', overdue: false };
  if (days <= 14) return { label: `Due in ${days}d`, overdue: false };
  return { label: `Due ${monthDay(targetDate)}`, overdue: false };
}

const isDone = (m: InitiativeMissionInput) => m.kind === 'done';
const needsYou = (m: InitiativeMissionInput) => !isDone(m) && (m.question != null || m.ask != null || m.statusLabel === 'Needs you');
const isHeld = (m: InitiativeMissionInput) => !isDone(m) && m.kind === 'held';

/** "Merge: feat(x): thing" → "Merge". The ask labels always lead with their verb. */
function askVerb(label: string): string {
  const i = label.indexOf(':');
  return i > 0 ? label.slice(0, i) : 'Open';
}

function missionRank(m: InitiativeMissionInput): number {
  if (needsYou(m)) return 0;
  if (isHeld(m)) return 1;
  if (m.statusLabel === 'Running' || m.statusLabel === 'In CI') return 2;
  if (isDone(m)) return 4;
  return 3;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export function buildInitiativeCard(input: InitiativeInput, opts: { now?: number } = {}): InitiativeCardModel {
  const now = opts.now ?? Date.now();
  const href = `/app/initiatives/${encodeURIComponent(input.id)}`;
  const missions = input.missions.filter((m) => m.status !== 'archived');
  const closed = input.status === 'completed' || input.status === 'archived';

  const done = missions.filter(isDone).length;
  const progress = {
    done,
    total: missions.length,
    tasksDone: missions.reduce((n, m) => n + m.done, 0),
    tasksTotal: missions.reduce((n, m) => n + m.total, 0),
  };

  // Segments keep the missions' own order so the bar does not reshuffle as
  // missions change state; the list below sorts by what needs you.
  const segments: InitiativeSegment[] = missions.map((m) => ({
    missionId: m.id,
    title: m.title,
    href: m.href,
    state: isDone(m) ? 'done' : needsYou(m) ? 'needs_you' : isHeld(m) ? 'held' : m.statusLabel === 'Running' || m.statusLabel === 'In CI' ? 'running' : 'waiting',
    fill: isDone(m) ? 1 : m.total > 0 ? Math.max(0, Math.min(1, m.done / m.total)) : 0,
  }));

  const lines: InitiativeMissionLine[] = [...missions]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => missionRank(a.m) - missionRank(b.m) || a.i - b.i)
    .map(({ m }) => ({
      id: m.id,
      title: m.title,
      href: m.href,
      statusLabel: m.statusLabel,
      tone: m.tone,
      done: m.done,
      total: m.total,
      failed: m.failed,
      note: m.failed > 0
        ? `${m.failed} failed`
        : isDone(m) && m.done < m.total
          ? `${m.total - m.done} unfinished`
          : null,
      criteria: m.criteria ?? null,
      phases: isDone(m) ? [] : m.phases ?? [],
      inlineQuestion: isDone(m) ? null : m.inlineQuestion ?? null,
      held: isHeld(m),
      ask: m.question
        ? { label: 'Answer', href: m.question.href }
        : m.ask && !isDone(m)
          ? { label: askVerb(m.ask.label), href: m.ask.href }
          : null,
    }));

  const facts: InitiativeFact[] = [];
  let action: InitiativeAction | null = null;

  if (!closed) {
    const asking = missions.filter(needsYou);
    const held = missions.filter(isHeld);
    if (asking.length > 0) {
      const first = asking[0];
      const firstHref = first.question?.href ?? first.ask?.href ?? first.href;
      facts.push({
        key: 'needs_you',
        text: `${asking.length} ${plural(asking.length, 'mission')} ${asking.length === 1 ? 'needs' : 'need'} you`,
        href: firstHref,
      });
      action = {
        kind: 'answer',
        label: first.question ? 'Answer' : first.ask ? askVerb(first.ask.label) : 'Open',
        href: firstHref,
        missionId: null,
      };
    }
    if (held.length > 0) {
      facts.push({ key: 'held', text: `${held.length} ${plural(held.length, 'mission')} held`, href: held[0].href });
      action ??= { kind: 'arm', label: 'Arm', href: held[0].href, missionId: held[0].id };
    }
    if (missions.length > 0 && done === missions.length) {
      facts.push({ key: 'all_done', text: missions.length === 1 ? 'Its mission is done' : `All ${missions.length} missions done`, href: null });
      action ??= { kind: 'mark_completed', label: 'Mark completed', href: null, missionId: null };
    }
    if (missions.length === 0) {
      facts.push({ key: 'no_missions', text: 'No missions yet', href: null });
      action = { kind: 'add_mission', label: 'Add mission', href: `/app/missions/new?initiative=${encodeURIComponent(input.id)}`, missionId: null };
    }
    action ??= { kind: 'open', label: 'Open', href, missionId: null };
  }

  const wantsYou = facts.some((f) => f.key === 'needs_you' || f.key === 'held' || f.key === 'all_done');
  const section: InitiativeSection = closed
    ? 'completed'
    : input.status === 'paused'
      ? 'paused'
      : wantsYou
        ? 'needs_you'
        : input.status === 'planned'
          ? 'planned'
          : 'active';

  return {
    id: input.id,
    title: input.title,
    description: input.description,
    href,
    status: input.status,
    statusLabel: INITIATIVE_STATUS_LABEL[input.status],
    owner: input.owner?.name ?? null,
    target: targetDateLabel(input.targetDate, input.status, now),
    progress,
    segments,
    missions: lines,
    facts,
    action,
    section,
  };
}

// ─── The list ─────────────────────────────────────────────────────────────────

const SECTION_ORDER: readonly InitiativeSection[] = ['needs_you', 'active', 'planned', 'paused', 'completed'];
export const SECTION_LABEL: Record<InitiativeSection, string> = {
  needs_you: 'Needs you',
  active: 'Active',
  planned: 'Planned',
  paused: 'Paused',
  completed: 'Completed',
};

export interface InitiativeGroup {
  section: InitiativeSection;
  label: string;
  cards: InitiativeCardModel[];
}

/** Sections in the order the owner acts on them; empty sections are dropped. Input order is kept within a section. */
export function groupInitiativeCards(cards: readonly InitiativeCardModel[]): InitiativeGroup[] {
  return SECTION_ORDER
    .map((section) => ({ section, label: SECTION_LABEL[section], cards: cards.filter((c) => c.section === section) }))
    .filter((g) => g.cards.length > 0);
}

export function initiativesHeadline(input: { needsYou: number; active: number }): string {
  if (input.needsYou > 0) return `${input.needsYou} ${input.needsYou === 1 ? 'needs' : 'need'} you`;
  if (input.active > 0) return `${input.active} active`;
  return 'Nothing active';
}
