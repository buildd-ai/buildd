import type { ActionQueueItem } from './action-queue';
import type { HomeQuestion, HomeHeldMission } from '@/app/app/(protected)/home/NeedsYouCards';
import type { HomeMissionRow } from '@/app/app/(protected)/home/HomeMissionsSummary';
import type { StrandCta } from './mission-list-card';
import type { WorkerWaitingFor } from '@buildd/core/db/schema';
import { unifyWorkerQuestion, type UnifiedQuestion } from '@/app/app/(protected)/tasks/[id]/question-hero';

export type AttentionActionType = 'merge' | 'review' | 'answer' | 'decide' | 'approve' | 'reconnect' | 'resolve' | 'fix' | 'check' | 'view' | 'stranded' | 'start' | 'incident';
export interface AttentionLink { label: string; href: string }

export interface HomeAttentionItem {
  key: string;
  kind: 'queue' | 'stranded' | 'question' | 'held';
  label: string;
  tone: 'ink' | 'error' | 'warning';
  title: string;
  sentence: string;
  meta: string;
  href: string;
  /** What the primary action does; summarised in the Home headline. */
  actionType: AttentionActionType;
  /** The named action and exactly where it happens. */
  primary?: AttentionLink;
  /** Diagnostic destination, only when it differs from the primary. */
  details?: AttentionLink | null;
  owner?: 'human' | 'platform' | 'agent';
  queue?: ActionQueueItem;
  strand?: StrandCta;
  question?: HomeQuestion;
  held?: HomeHeldMission;
  /**
   * One cause across many subjects (a dead key, a lost connector): shown once,
   * apart from per-subject decisions. `subjects` names what it hits.
   */
  systemic?: { count: number; subjects: string[] };
}

/**
 * THE "Buildd owns the next move, so this is not a decision" rule for Home,
 * the badge and the headline. The escalation gate's verdict decides
 * (lib/escalation-gate-check.ts, `gate`): Buildd's own next step, or what Jev
 * judged Buildd can do itself, is never a card. Without a verdict (the gate
 * did not run), a human review on a PR Buildd is still repairing or checking
 * (`machineActing`, from `reviewMachineActing` in action-queue.ts) waits too.
 */
export function waitsOnBuildd(i: Pick<ActionQueueItem, 'humanReview' | 'machineActing' | 'prLifecycleStatus' | 'gate'>): boolean {
  if (i.prLifecycleStatus === 'merged' || i.prLifecycleStatus === 'closed') return false;
  if (i.gate) return i.gate.owner === 'buildd';
  return !!i.humanReview && !!i.machineActing;
}

/**
 * Work the platform is already recovering on its own: an agent-handled chip, a
 * fix or CI run in flight, or a conflict retry with attempts left. It is never
 * a Needs you card. A human review waits too while Buildd is still repairing or
 * checking its PR (`machineActing`): reviewing a diff that is about to change is
 * wasted. Once that settles, a protected-path review needs a person whatever CI says.
 */
export function isAutoRecovering(i: ActionQueueItem, isActionable: (chip: ActionQueueItem['chip']) => boolean): boolean {
  if (!isActionable(i.chip)) return true;
  // A review on a PR Buildd is still repairing or checking waits for that to settle.
  if (waitsOnBuildd(i)) return true;
  if (i.humanReview || i.chip !== 'BLOCKED') return false;
  if (i.ciGate?.kind === 'fixing' || i.ciGate?.kind === 'running') return true;
  return !!i.conflictRetryTaskId && !i.deadZoneExhausted;
}

/** Causes that are about the setup, not one task: collapse when repeated. */
const SYSTEMIC_ACTIONS: ReadonlySet<AttentionActionType> = new Set(['view', 'reconnect', 'resolve']);

/**
 * The same failure on several subjects is one problem, not N cards: fold
 * setup-cause queue items (failed, reconnect, blocked) that share label and
 * reason into one systemic item. Per-subject decisions (merge, review, answer,
 * a per-PR fix) are never folded. A lost connector is systemic on its own,
 * because every agent using it is paused.
 */
export function collapseSystemic(items: readonly HomeAttentionItem[]): HomeAttentionItem[] {
  const groups = new Map<string, HomeAttentionItem[]>();
  const keyOf = (i: HomeAttentionItem) => {
    if (i.kind !== 'queue' || !SYSTEMIC_ACTIONS.has(i.actionType)) return null;
    return `${i.label}\u0000${i.sentence.trim().toLowerCase()}`;
  };
  for (const i of items) {
    const k = keyOf(i);
    if (k) groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const out: HomeAttentionItem[] = [];
  const emitted = new Set<string>();
  for (const i of items) {
    const k = keyOf(i);
    const group = k ? groups.get(k)! : [i];
    if (group.length < 2) {
      out.push(i.queue?.chip === 'RECONNECT' ? { ...i, systemic: { count: 1, subjects: [i.title] } } : i);
      continue;
    }
    if (emitted.has(k!)) continue;
    emitted.add(k!);
    const subjects = [...new Set(group.map(g => g.title))];
    // One fix for all of them (a settings page) is the action; else the list.
    const fix = i.queue?.fixHref;
    const sameFix = !!fix && group.every(g => g.queue?.fixHref === fix);
    const named = subjects.slice(0, 2).join(', ');
    const rest = subjects.length - 2;
    const primary = sameFix ? { label: i.queue?.fixLabel?.trim() || 'Fix', href: fix! } : { label: 'See all in Activity', href: '/app/tasks' };
    out.push({
      ...i,
      key: `systemic:${group.map(g => g.key).sort().join('|')}`,
      title: i.sentence,
      sentence: `Seen on ${named}${rest > 0 ? ` and ${rest} more` : ''}.`,
      meta: `${group.length} affected`,
      href: primary.href,
      primary,
      details: null,
      systemic: { count: group.length, subjects },
    });
  }
  return out;
}


/**
 * A parked worker's question as Home renders it: the same normalized question
 * as the task page (`unifyWorkerQuestion`), with the worker's own error and the
 * task title as the context fallback, so the card can never be the bare prompt.
 */
export function homeQuestionView(row: { waitingFor: unknown; error?: string | null; taskTitle?: string | null }): UnifiedQuestion | null {
  const wf = row.waitingFor as WorkerWaitingFor | null;
  if (!wf || typeof wf.prompt !== 'string' || !wf.prompt.trim()) return null;
  return unifyWorkerQuestion(wf, null, { workerError: row.error, taskTitle: row.taskTitle });
}

/** The card's "why": what the agent said, else its default, else where it was asked. */
function questionSentence(q: HomeQuestion): string {
  const rec = q.question.options.find(o => o.recommended);
  return q.question.context ?? q.question.body ?? (rec ? `Recommended: ${rec.label}` : `Asked while working on ${q.label}.`);
}

type Resolved = Pick<HomeAttentionItem, 'label' | 'tone' | 'title' | 'sentence' | 'meta' | 'href' | 'actionType' | 'primary' | 'details' | 'owner'>;

/**
 * The four answers a Needs You card must carry: what (title), why (sentence), what to do
 * (primary label) and where (primary href). Returns null when any is unknown.
 */
export function resolveQueueAttention(i: ActionQueueItem): Resolved | null {
  const text = (v?: string | null) => v?.trim() || null;
  const subject = text(i.taskTitle) ?? text(i.missionTitle) ?? text(i.connectorName) ?? (i.prNumber != null ? `PR #${i.prNumber}` : null);
  const taskHref = i.taskId ? `/app/tasks/${i.taskId}` : null;
  const subjectHref = i.missionId ? `/app/missions/${i.missionId}` : taskHref;
  const meta = i.prNumber != null ? `PR #${i.prNumber}` : i.workspaceName ?? '';
  const make = (r: { label: string; tone: HomeAttentionItem['tone']; title: string | null; sentence: string | null; actionType: AttentionActionType; primary: AttentionLink | null; details?: AttentionLink | null }): Resolved | null => {
    if (!r.title || !r.sentence || !r.primary?.href) return null;
    const details = r.details && r.details.href !== r.primary.href ? r.details : null;
    return { label: r.label, tone: r.tone, title: r.title, sentence: r.sentence, meta, href: r.primary.href, actionType: r.actionType, primary: r.primary, details, owner: 'human' };
  };
  const pr = text(i.prUrl);
  switch (i.chip) {
    case 'MERGE': {
      const reason = i.docFixTaskId ? 'The code moved ahead of this spec. This PR brings the doc back in line.'
        : i.approvedSha ? 'Checks passed and the review approved this commit. Merging is your call.' : 'Checks passed. Merging is your call.';
      return make({ label: 'ready for your merge', tone: 'ink', title: subject, sentence: reason, actionType: 'merge', primary: { label: 'Merge', href: pr ?? subjectHref ?? '' }, details: pr ? { label: 'Review PR', href: pr } : null });
    }
    case 'REVIEW': {
      const reason = i.humanReview ? [i.humanReview.decision ?? i.humanReview.reason, i.machineStatus].filter(Boolean).join(' · ') : text(i.verdictSummary) ?? text(i.escalationReason);
      return make({ label: 'review needed', tone: 'warning', title: subject, sentence: text(reason), actionType: 'review', primary: { label: text(i.humanReview?.label) ?? 'Review PR', href: pr ? `${pr}/files` : subjectHref ?? '' }, details: subjectHref ? { label: 'View task', href: subjectHref } : null });
    }
    case 'QUESTION':
      return make({ label: 'question', tone: 'warning', title: text(i.question) ?? subject, sentence: text(i.question) && subject ? `Asked while working on ${subject}.` : 'An agent is waiting for your answer.', actionType: 'answer', primary: { label: 'Answer', href: taskHref ?? subjectHref ?? '' } });
    case 'DECIDE': {
      const title = text(i.noteTitle) ?? text(i.escalationReason) ?? text(i.recommendation);
      return make({ label: 'decision', tone: 'warning', title, sentence: text(i.recommendation) && title !== text(i.recommendation) ? `Recommended: ${text(i.recommendation)}` : subject ? `Mission: ${subject}` : 'The mission is waiting on your choice.', actionType: 'decide', primary: { label: 'Choose…', href: subjectHref ?? '' } });
    }
    case 'APPROVE':
      return make({ label: 'approval', tone: 'warning', title: subject, sentence: text(i.verdictSummary) ?? 'This work is waiting for your approval before it starts.', actionType: 'approve', primary: { label: 'Approve…', href: text(i.fixHref) ?? subjectHref ?? '' } });
    case 'RECONNECT':
      return make({ label: 'reconnect', tone: 'warning', title: text(i.connectorName), sentence: text(i.failureMessage) ?? (i.connectorName ? `${i.connectorName} lost its connection. Agents using it are paused.` : null), actionType: 'reconnect', primary: { label: text(i.fixLabel) ?? 'Reconnect', href: text(i.fixHref) ?? '' } });
    case 'DISCREPANCY': {
      const dir = i.direction === 'spec_ahead' ? 'The spec describes work the code does not do yet.' : i.direction === 'code_ahead' ? 'The code does something the spec does not describe.' : i.direction === 'contradicted' ? 'The code contradicts the spec.' : null;
      return make({ label: 'spec mismatch', tone: 'warning', title: text(i.specPath) ?? subject, sentence: dir, actionType: 'resolve', primary: { label: 'Resolve…', href: text(i.fixHref) ?? subjectHref ?? '' } });
    }
    case 'BLOCKED': {
      const ci = i.ciGate?.kind === 'blocked' && !i.mergeConflict && !i.deadZoneExhausted;
      const reason = ci ? 'Tests are failing. No fix is running.' : i.mergeConflict ? text(i.conflictReason) ?? 'The branch conflicts with its base and needs resolving.' : text(i.escalationReason) ?? text(i.failureMessage);
      return make({ label: ci ? 'tests failing' : 'blocked', tone: 'error', title: subject, sentence: reason, actionType: ci ? 'fix' : 'resolve', primary: { label: ci ? 'Start fix' : 'Resolve…', href: pr ?? subjectHref ?? '' }, details: pr && ci ? { label: 'Logs', href: `${pr}/checks` } : null });
    }
    case 'STALE':
      return make({ label: 'check needed', tone: 'warning', title: subject, sentence: pr ? 'The last known tests and review are out of date. Check the PR before deciding.' : null, actionType: 'check', primary: { label: 'Check PR', href: pr ?? '' } });
    case 'INCIDENT':
      // The stored escalation-gate verdict (lib/failure-incident-escalation.ts) put it here; its reason is the sentence.
      return make({ label: 'incident', tone: 'error', title: text(i.incidentTitle), sentence: text(i.failureMessage), actionType: 'incident', primary: { label: text(i.fixLabel) ?? 'Open incident', href: text(i.fixHref) ?? '' } });
    case 'FAILED':
      return make({ label: 'failed', tone: 'error', title: subject, sentence: text(i.failureMessage), actionType: 'view', primary: { label: 'View task', href: taskHref ?? subjectHref ?? '' } });
    default:
      return null;
  }
}

/** One owner decision per subject. PR identity includes the workspace because numbers are repository-local. */
export function deriveHomeAttention({ queue, missions, questions, held, isActionable }: {
  /** Supplied by Home, where the action queue and core UI are composed. */
  isActionable: (chip: ActionQueueItem['chip']) => boolean;
  queue: readonly ActionQueueItem[];
  missions: readonly HomeMissionRow[];
  questions: readonly HomeQuestion[];
  held: readonly HomeHeldMission[];
}): HomeAttentionItem[] {
  const items = new Map<string, HomeAttentionItem>();
  for (const q of questions) {
    const key = `question:${q.taskId ?? q.workerId}`;
    items.set(key, { key, kind: 'question', label: 'needs input', tone: 'warning', title: q.question.headline, sentence: questionSentence(q), meta: q.label, href: q.href ?? '/app/activity', actionType: 'answer', owner: 'human', question: q });
  }
  // Conservative precedence: a stale or blocked reading must never become a merge CTA through dedupe.
  const priority = (i: ActionQueueItem) => i.chip === 'STALE' ? 3 : i.chip === 'BLOCKED' ? 2 : 1;
  const prs = new Map<string, ActionQueueItem>();
  for (const i of queue) {
    if (i.prLifecycleStatus === 'merged' || i.prLifecycleStatus === 'closed') continue;
    const key = i.prNumber != null && i.workspaceId ? `pr:${i.workspaceId}:${i.prNumber}` : i.subjectKey;
    const old = prs.get(key);
    // A live fix/check suppresses an older actionable representation of the same PR.
    if (i.humanReview || old?.humanReview) {
      if (!old?.humanReview) prs.set(key, i);
    } else if (!old || !isActionable(i.chip) || (isActionable(old.chip) && priority(i) > priority(old))) {
      prs.set(key, i);
    }
  }
  for (const [key, i] of prs) {
    if (isAutoRecovering(i, isActionable)) continue;
    if (i.chip === 'QUESTION' && questions.some(q => (q.taskId && q.taskId === i.taskId) || q.workerId === i.workerId)) continue;
    const docFix = queue.find(row => row.docFixTaskId && row.docFixTaskId === i.taskId);
    const displayItem = docFix ? { ...i, docFixTaskId: docFix.docFixTaskId } : i;
    const resolved = resolveQueueAttention(displayItem);
    // Unresolvable subject, reason or destination: a data defect, not an owner card.
    if (!resolved) continue;
    items.set(key, { key, kind: 'queue', ...resolved, queue: displayItem });
  }
  for (const { view, model } of missions) {
    if (!model.strand) continue;
    const key = `mission:${view.id}`;
    const hours = Math.floor(model.strand.quietMs / 3600000);
    items.set(key, { key, kind: 'stranded', label: 'stranded', tone: 'warning', title: view.title, sentence: hours > 0 ? `No local session for ${hours} hour${hours === 1 ? '' : 's'}.` : 'The local session has stopped.', meta: 'local', href: view.href, actionType: 'stranded', owner: 'human', strand: model.strand });
  }
  for (const m of held) {
    const key = `mission:${m.id}`;
    if (!items.has(key)) items.set(key, { key, kind: 'held', label: 'held', tone: 'warning', title: m.title, sentence: 'The work is ready for you to start.', meta: `${m.ready} ready`, href: m.href, actionType: 'start', owner: 'human', held: m });
  }
  return collapseSystemic([...items.values()]);
}

/** A waiting task as the layout's needs-input feed carries it (components/needs-input-context.ts). */
export interface WaitingInputTask {
  id: string;
  title: string;
  missionId?: string | null;
  waitingFor: { prompt?: string; context?: string } | null;
  answerSent?: boolean;
}

/**
 * Admit every task the global needs-input banner would name. Home's own
 * question loader and the banner's feed read different queries (scope, window,
 * row cap), so without this the banner names a task the inbox does not count.
 * Home is the one list of what needs you: whatever the banner holds is in it.
 * `hrefFor` is the banner's own link, so both point at the same place.
 */
export function admitWaitingTasks(items: readonly HomeAttentionItem[], waiting: readonly WaitingInputTask[], hrefFor: (t: WaitingInputTask) => string): HomeAttentionItem[] {
  const covered = new Set<string>();
  for (const i of items) {
    if (i.question?.taskId) covered.add(i.question.taskId);
    if (i.queue?.chip === 'QUESTION' && i.queue.taskId) covered.add(i.queue.taskId);
  }
  const out = [...items];
  for (const t of waiting) {
    // An answered question waits on the agent, not the person.
    if (t.answerSent || covered.has(t.id)) continue;
    covered.add(t.id);
    const href = hrefFor(t);
    const prompt = t.waitingFor?.prompt?.trim();
    out.push({
      key: `question:${t.id}`, kind: 'question', label: 'needs input', tone: 'warning',
      title: prompt || t.title,
      sentence: t.waitingFor?.context?.trim() || `Asked while working on ${t.title}.`,
      meta: '', href, actionType: 'answer', primary: { label: 'Answer', href }, owner: 'human',
    });
  }
  return out;
}

/** Shared grammar for attention lists; each surface keeps its existing zero copy. */
export function needsYouHeadline(count: number, empty = 'All good.'): string {
  return count === 0 ? empty : count === 1 ? '1 thing needs you.' : `${count} things need you.`;
}

const ACTION_NOUN: Record<AttentionActionType, [string, string]> = {
  merge: ['merge', 'merges'], review: ['review', 'reviews'], answer: ['question', 'questions'], decide: ['decision', 'decisions'],
  approve: ['approval', 'approvals'], reconnect: ['reconnect', 'reconnects'], resolve: ['blocker', 'blockers'], fix: ['failing PR', 'failing PRs'],
  check: ['check', 'checks'], view: ['failed task', 'failed tasks'], stranded: ['stranded mission', 'stranded missions'], start: ['mission to start', 'missions to start'],
  incident: ['incident', 'incidents'],
};

/** "review" / "reviews", the same nouns the headline sub-line uses. */
export function actionNoun(type: AttentionActionType, n: number): string {
  return ACTION_NOUN[type][n === 1 ? 0 : 1];
}

/**
 * `runnerConnected: false` (a team with no runner yet) changes only the empty
 * sub-line: there is no fleet to be "working without you".
 */
export function homeAttentionCopy(items: readonly HomeAttentionItem[], opts: { runnerConnected?: boolean } = {}) {
  const count = items.length;
  const counts = new Map<AttentionActionType, number>();
  for (const i of items) counts.set(i.actionType, (counts.get(i.actionType) ?? 0) + 1);
  const idle = opts.runnerConnected === false ? 'No runner is connected yet, so nothing is running.' : 'The fleet is working without you.';
  const subline = [...counts].map(([t, n]) => `${n} ${ACTION_NOUN[t][n === 1 ? 0 : 1]}`).join(' · ') || idle;
  return { count, headline: needsYouHeadline(count, 'Nothing needs you.'), subline };
}
