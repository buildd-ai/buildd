/** Stored facts only. A repair belongs to its trigger, never to the newest round by accident. */
import type { DeliveryView } from './workflow/projections';
import { repairLabelOf, repairPhaseOf } from './workflow/projections';
import { roundReading } from './task-checks';
import { DELIVERY_STAGES, deliveryStageIndex, type DeliveryKind } from './delivery-projection';
import { groupAttemptHistory } from '@/app/app/(protected)/tasks/[id]/bookkeeping-attempt';
import { formatElapsed } from '@/app/app/(protected)/tasks/[id]/format-elapsed';
import type { LineageStep } from '@/app/app/(protected)/tasks/[id]/pr-lineage';

export interface TimelineEvent {
  id: string;
  label: string;
  detail: string | null;
  taskId?: string | null;
  state: 'passed' | 'failed' | 'running' | 'pending' | 'muted';
  children: TimelineEvent[];
}
export interface TimelineGroup { label: typeof DELIVERY_STAGES[number]; events: TimelineEvent[] }
interface BuildWorker { id: string; status: string; exitCause?: string | null; error?: string | null; startedAt?: Date | string | null; completedAt?: Date | string | null; turns?: number | null; filesChanged?: number | null; linesAdded?: number | null; linesRemoved?: number | null }
export interface TaskTimelineInput {
  task: { status: string; startAt?: Date | string | null };
  /** Newest first, just this task's workers; child repairs are separate events. */
  workers: readonly BuildWorker[];
  kind: DeliveryKind;
  delivery?: DeliveryView | null;
  lineage?: readonly LineageStep[];
  ciAttemptTasks?: readonly { id: string; status: string }[];
}
const stateOf = (status: string): TimelineEvent['state'] => status === 'completed' ? 'passed' : status === 'failed' ? 'failed' : ['running', 'in_progress', 'assigned', 'starting'].includes(status) ? 'running' : 'muted';
const event = (id: string, label: string, state: TimelineEvent['state'], detail: string | null = null, taskId?: string | null): TimelineEvent => ({ id, label, detail, state, taskId, children: [] });

export function buildTaskTimeline(input: TaskTimelineInput): TimelineGroup[] {
  const groups: TimelineGroup[] = DELIVERY_STAGES.map(label => ({ label, events: [] }));
  const [build, verify, deliver] = groups.map(g => g.events);
  for (const item of groupAttemptHistory(input.workers.map(worker => ({ worker })), input.task).reverse()) {
    if (item.kind === 'bookkeeping') {
      build.push(event(`claims:${item.entries[0].worker.id}`, `${item.entries.length} ${item.entries.length === 1 ? 'claim' : 'claims'} without a session`, 'muted'));
    } else {
      const w = item.entry.worker;
      const duration = w.startedAt && w.completedAt ? new Date(w.completedAt).getTime() - new Date(w.startedAt).getTime() : null;
      const detail = [duration != null && duration >= 0 ? formatElapsed(duration) : null, w.turns ? `${w.turns} turns` : null, w.filesChanged ? `${w.filesChanged} files` : null, w.linesAdded || w.linesRemoved ? `+${w.linesAdded ?? 0} −${w.linesRemoved ?? 0} lines` : null].filter(Boolean).join(' · ') || null;
      build.push(event(`worker:${w.id}`, w.status === 'completed' ? 'Built' : w.status === 'failed' ? 'Build stopped' : 'Builder started', stateOf(w.status), detail));
    }
  }
  const v = input.delivery;
  if (v) {
    const rounds = new Map<string, TimelineEvent>();
    for (const r of [...v.rounds].sort((a, b) => a.round - b.round)) {
      const read = roundReading(r);
      const row = event(`round:${r.id}`, `Code review · ${read.word} · round ${r.round}`, read.state === 'passed' || read.state === 'failed' || read.state === 'running' ? read.state : 'muted', null, r.reviewerTaskId);
      rounds.set(r.id, row);
      verify.push(row);
    }
    for (const a of v.ledger) {
      if (a.mode === 'mechanical') {
        deliver.push(event(`attempt:${a.id}`, 'Branch update', stateOf(a.status)));
        continue;
      }
      const phase = repairPhaseOf(a, v);
      const fix = event(`attempt:${a.id}`, repairLabelOf(a, v.ledger), a.outcome === 'delivered' ? 'passed' : stateOf(a.status), phase, a.taskId);
      const round = a.triggerReason ? rounds.get(a.triggerReason) : null;
      if (round) { round.children.push(fix); continue; }
      const isMerge = ['conflict', 'migration', 'trunk'].includes(a.family);
      const list = isMerge ? deliver : verify;
      const cause = event(`cause:${a.id}`, a.family === 'ci' ? 'CI failed' : isMerge ? 'Merge conflict' : 'Review fix requested', 'failed');
      cause.children.push(fix);
      list.push(cause);
    }
    if (v.prState === 'ci_passed') verify.push(event('ci:current', 'CI passed', 'passed'));
    else if (v.prState === 'ci_failed') verify.push(event('ci:current', 'CI failed on the current head', 'failed'));
    else if (v.prState === 'awaiting_ci' || v.prState === 'ci_running') verify.push(event('ci:current', 'CI checking', 'running'));
    if (v.state === 'MERGED') deliver.push(event('merged', 'Merged', 'passed'));
    else if (v.state === 'LANDING') deliver.push(event('landing', 'Merging', 'running'));
    else if (v.state === 'CLOSED_UNMERGED' || v.state === 'ABANDONED') deliver.push(event('closed', 'Closed without merging', 'muted'));
  } else {
    let cause: TimelineEvent | null = null;
    let retryIndex = 0;
    for (const [i, step] of (input.lineage ?? []).entries()) {
      if (step.kind === 'attempt') {
        if ((step.n ?? 1) > 1 && cause) {
          const task = input.ciAttemptTasks?.[retryIndex++];
          cause.children.push(event(`legacy:fix:${i}`, `Fix ${retryIndex}`, task ? stateOf(task.status) : 'muted', step.sub || null, task?.id));
        }
        continue;
      }
      if (step.kind === 'retry') continue;
      const row = event(`legacy:${i}`, step.title, step.kind === 'ci_failed' ? 'failed' : step.kind === 'ci_running' ? 'running' : 'passed', step.sub || null);
      (step.kind === 'merged' ? deliver : verify).push(row);
      if (step.kind === 'ci_failed') cause = row;
    }
  }
  // Future stages have only their name in the track; no empty card.
  const at = deliveryStageIndex(input.kind);
  return groups.filter((g, i) => g.events.length > 0 || (input.workers.length > 0 && i <= Math.min(at, 2)));
}
