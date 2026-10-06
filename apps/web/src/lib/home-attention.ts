import { isActionableChip, type ActionQueueItem } from './action-queue';
import type { HomeQuestion, HomeHeldMission } from '@/app/app/(protected)/home/NeedsYouCards';
import type { HomeMissionRow } from '@/app/app/(protected)/home/HomeMissionsSummary';
import type { StrandCta } from './mission-list-card';

export interface HomeAttentionItem {
  key: string;
  kind: 'queue' | 'stranded' | 'question' | 'held';
  label: string;
  tone: 'ink' | 'error' | 'warning';
  title: string;
  sentence: string;
  meta: string;
  href: string;
  queue?: ActionQueueItem;
  strand?: StrandCta;
  question?: HomeQuestion;
  held?: HomeHeldMission;
}

/** One owner decision per subject. PR identity includes the workspace because numbers are repository-local. */
export function deriveHomeAttention({ queue, missions, questions, held }: {
  queue: readonly ActionQueueItem[];
  missions: readonly HomeMissionRow[];
  questions: readonly HomeQuestion[];
  held: readonly HomeHeldMission[];
}): HomeAttentionItem[] {
  const items = new Map<string, HomeAttentionItem>();
  for (const q of questions) {
    const key = `question:${q.taskId ?? q.workerId}`;
    items.set(key, { key, kind: 'question', label: 'needs input', tone: 'warning', title: q.prompt, sentence: 'An agent needs your answer to continue.', meta: q.label, href: q.href ?? '/app/activity', question: q });
  }
  // Conservative precedence: a stale or blocked reading must never become a merge CTA through dedupe.
  const priority = (i: ActionQueueItem) => i.chip === 'STALE' ? 3 : i.chip === 'BLOCKED' ? 2 : 1;
  const prs = new Map<string, ActionQueueItem>();
  for (const i of queue) {
    if (i.prLifecycleStatus === 'merged' || i.prLifecycleStatus === 'closed') continue;
    const key = i.prNumber != null && i.workspaceId ? `pr:${i.workspaceId}:${i.prNumber}` : i.subjectKey;
    const old = prs.get(key);
    // A live fix/check suppresses an older actionable representation of the same PR.
    if (!old || !isActionableChip(i.chip) || (isActionableChip(old.chip) && priority(i) > priority(old))) prs.set(key, i);
  }
  for (const [key, i] of prs) {
    if (!isActionableChip(i.chip)) continue;
    if (i.chip === 'QUESTION' && questions.some(q => (q.taskId && q.taskId === i.taskId) || q.workerId === i.workerId)) continue;
    const docFix = queue.find(row => row.docFixTaskId && row.docFixTaskId === i.taskId);
    const displayItem = docFix ? { ...i, docFixTaskId: docFix.docFixTaskId } : i;
    const merge = i.chip === 'MERGE';
    const ci = i.chip === 'BLOCKED' && i.ciGate?.kind === 'blocked' && !i.mergeConflict && !i.deadZoneExhausted;
    const label = merge ? 'ready to merge' : ci ? 'tests failing' : i.chip === 'STALE' ? 'check needed' : i.chip === 'REVIEW' ? 'review needed' : i.chip === 'RECONNECT' ? 'reconnect' : 'needs input';
    const sentence = merge ? (displayItem.docFixTaskId ? 'The code moved ahead of this spec. This PR brings the doc back in line.' : 'The checks are clear. Nothing else is blocking it.')
      : ci ? 'Tests are failing. No fix is running.'
      : i.chip === 'STALE' ? 'Check the latest tests and review before deciding.'
      : i.chip === 'REVIEW' ? 'Review the changes before deciding what happens next.'
      : i.chip === 'RECONNECT' ? 'Reconnect so agents can continue.'
      : i.chip === 'DISCREPANCY' ? 'The code and its spec disagree. Choose what should change.'
      : i.chip === 'BLOCKED' ? 'This change needs a decision before it can move on.'
      : 'Open the work to choose the next step.';
    items.set(key, { key, kind: 'queue', label, tone: ci || i.chip === 'BLOCKED' || i.chip === 'FAILED' ? 'error' : merge ? 'ink' : 'warning', title: i.taskTitle ?? i.missionTitle ?? i.connectorName ?? 'Work needs a decision', sentence, meta: i.prNumber != null ? `PR #${i.prNumber}` : i.workspaceName ?? '', href: i.missionId ? `/app/missions/${i.missionId}` : i.taskId ? `/app/tasks/${i.taskId}` : i.fixHref ?? '/app/health', queue: displayItem });
  }
  for (const { view, model } of missions) {
    if (!model.strand) continue;
    const key = `mission:${view.id}`;
    const hours = Math.floor(model.strand.quietMs / 3600000);
    items.set(key, { key, kind: 'stranded', label: 'stranded', tone: 'warning', title: view.title, sentence: hours > 0 ? `No local session for ${hours} hour${hours === 1 ? '' : 's'}.` : 'The local session has stopped.', meta: 'local', href: view.href, strand: model.strand });
  }
  for (const m of held) {
    const key = `mission:${m.id}`;
    if (!items.has(key)) items.set(key, { key, kind: 'held', label: 'held', tone: 'warning', title: m.title, sentence: 'The work is ready for you to start.', meta: `${m.ready} ready`, href: m.href, held: m });
  }
  return [...items.values()];
}

export function homeAttentionCopy(items: readonly HomeAttentionItem[]) {
  const count = items.length;
  const merges = items.filter(i => i.label === 'ready to merge').length;
  const blocked = items.filter(i => i.label === 'tests failing').length;
  const stranded = items.filter(i => i.kind === 'stranded').length;
  const other = count - merges - blocked - stranded;
  const subline = [
    merges > 0 && `${merges} merge${merges === 1 ? ' is' : 's are'} ready.`,
    blocked > 0 && `${blocked} PR${blocked === 1 ? ' is' : 's are'} stuck on tests.`,
    stranded > 0 && `${stranded} mission${stranded === 1 ? '' : 's'} lost ${stranded === 1 ? 'its' : 'their'} session.`,
    other > 0 && `${other} decision${other === 1 ? '' : 's'} to make.`,
  ].filter(Boolean).join(' ') || 'The fleet is working without you.';
  return { count, headline: count === 0 ? 'Nothing needs you.' : count === 1 ? '1 thing needs you.' : `${count} things need you.`, subline };
}
