'use client';

/**
 * Home's one-tap Needs-you cards: a parked worker's question (the one
 * decision card every surface shares, Navigation d25d923d R-16) and a held
 * mission (Arm). Home keeps its own layout; only the card takes that shape.
 */
import { MISSION_START_COPY, type MissionStartState } from '@/lib/mission-start-state';
import Link from 'next/link';
import { ArmButton } from '@/components/missions/MissionListCards';
import DecisionCard from '@/components/DecisionCard';
import { approvalView, decisionFromQuestion, type DecisionView } from '@/lib/needs-you-card';
import type { HomeAttentionItem } from '@/lib/home-needs-you';
import { displayTaskTitle } from '@/lib/task-title';
import type { UnifiedQuestion } from '../tasks/[id]/question-hero';

export interface HomeQuestion {
  workerId: string;
  taskId: string | null;
  href: string | null;
  label: string;
  runnerName: string | null;
  askedAt: string | null;
  /** The same normalized question the task page renders (lib/home-attention.ts `homeQuestionView`). */
  question: UnifiedQuestion;
}

/** "Per line — match Stripe" → { main: "Per line", sub: "match Stripe" }. */
export function splitOption(opt: string): { main: string; sub: string | null } {
  const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(opt);
  return m ? { main: m[1], sub: m[2] } : { main: opt, sub: null };
}

/**
 * A Home question as the shared decision card reads it (Navigation R-16):
 * the task it belongs to (its page is where the full answer lives), its
 * age, the brief, and the worker the answer goes to. Home does not load who
 * waits on the task; the mission page names them.
 */
export function questionDecisionView(q: HomeQuestion): DecisionView {
  return decisionFromQuestion({
    key: `question:${q.taskId ?? q.workerId}`,
    question: q.question,
    // Home already built the task page link (`taskAnswerHref`); a question with no task names none.
    task: q.taskId && q.href ? { id: q.taskId, title: q.label, href: q.href } : null,
    askedAt: q.askedAt ? new Date(q.askedAt).getTime() : null,
    answer: { kind: 'worker', workerId: q.workerId, taskId: q.taskId, noteId: q.question.noteId },
  });
}

/** A parked worker's question on Home: the one decision card. */
export function QuestionCard({ q, now = Date.now(), onAnswered }: { q: HomeQuestion; now?: number; onAnswered?: (label: string) => void }) {
  return <DecisionCard view={questionDecisionView(q)} now={now} onAnswered={onAnswered} testId="needs-you-card" />;
}

const sentence = (s: string | null | undefined) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? (/[.!?]$/.test(t) ? t : `${t}.`) : null;
};

/**
 * A review a person must give on a PR, as the shared decision card's
 * approval (Navigation R-16): Approve and Request changes, each with its
 * effect, the diff linked from the why. The links go where the mission page's
 * approval goes (the PR, its files), so both surfaces draw the same card.
 * Null for anything else, and for a review with no PR to decide on.
 */
export function reviewApprovalView(item: HomeAttentionItem): DecisionView | null {
  const q = item.queue;
  const pr = q?.prUrl?.trim();
  if (q?.chip !== 'REVIEW' || !pr) return null;
  const review = q.humanReview;
  const why = review ? [sentence(review.decision ?? review.reason), sentence(q.machineStatus)].filter(Boolean).join(' ') : item.sentence;
  const title = displayTaskTitle(item.title);
  // The subject link Home already resolved (the mission, or the task page), never a hand-built task path.
  const href = item.details?.href ?? pr;
  return approvalView({
    key: `approval:${q.taskId ?? item.key}`,
    task: { id: q.taskId ?? item.key, title, href },
    askedAt: null,
    reason: why || null,
    diffHref: `${pr}/files`,
    approveHref: pr,
    changesHref: `${pr}/files`,
  });
}

export interface HomeHeldMission {
  id: string;
  title: string;
  href: string;
  ready: number;
  roles: string[];
  done: number;
  total: number;
  heldFor: string | null;
  /** Not started (the default) or paused. */
  startState?: MissionStartState;
}

export function HeldMissionCard({ m }: { m: HomeHeldMission }) {
  const role = m.roles.length === 1 ? `${m.roles[0]} ` : '';
  const copy = MISSION_START_COPY[m.startState ?? 'not_started'];
  return (
    <article data-testid="needs-you-card" data-kind="held" className="card px-4 py-4 md:px-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-text-secondary">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 border-2 border-text-secondary" />
          {copy.label}
        </span>
        {m.heldFor && <span className="font-mono text-[11px] text-text-muted">for {m.heldFor}</span>}
      </div>
      <h3 className="truncate font-mono text-[15px] font-semibold text-text-primary">{m.title}</h3>
      <p className="mt-1 font-mono text-[12px] text-text-muted">
        {m.ready} {role}task{m.ready === 1 ? '' : 's'} ready · {m.done}/{m.total}
      </p>
      <div className="mt-3.5 flex gap-2.5">
        <ArmButton missionId={m.id} startState={m.startState} />
        <Link href={m.href} className="inline-flex min-h-11 items-center border-2 border-border-default px-3.5 font-mono text-[12.5px] text-text-primary hover:bg-surface-3 md:min-h-9">
          Open
        </Link>
      </div>
    </article>
  );
}
