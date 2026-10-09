'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { HomeAttentionItem } from '@/lib/home-needs-you';
import { firstSentence } from '@/lib/attention-line';
import { resolveMergeOutcome } from '@/lib/merge-outcome';
import { ReviewDecision } from '@/components/ReviewDecision';
import { MergeAdvice } from '@/components/MergeAdvice';
import Eyebrow from '@/components/ui/Eyebrow';

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const primary = 'btn btn-ink min-h-11';
const secondary = 'btn min-h-11';

/**
 * One owner decision, the same card at every width: the L3 decision frame
 * (1.5px frame on --inset, no shadow), a sentence-case orange eyebrow, the subject, then the
 * ReviewDecision body (one decision line, fact tags, Details folded), the
 * MergeAdvice line when the PR has one, and a charcoal primary action.
 */
export function DecisionCard({ item, onDone }: { item: HomeAttentionItem; onDone: (key: string, label: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [retrySafe, setRetrySafe] = useState(true);
  useEffect(() => { setConfirm(false); setError(null); setRetrySafe(true); }, [item]);
  const q = item.queue;
  const merge = q?.chip === 'MERGE' && q.prNumber != null && !!q.workspaceId;
  const ci = item.label === 'tests failing' && q?.prNumber != null && !!q.workspaceId;
  const blocked = merge ? q?.missionMergeBlockedReason : item.strand?.blockedReason;
  const recordStrand = (label: string) => {
    if (!item.strand) return;
    void fetch(`/api/missions/${encodeURIComponent(item.strand.missionId)}/strand-choice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, order: 'runner-first', quietMs: item.strand.quietMs }) }).catch(() => {});
  };
  async function act(url: string, body: object, label: string, method = 'POST') {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (merge) {
        const outcome = resolveMergeOutcome(res.ok, res.status, data);
        if (outcome.kind === 'merged' || outcome.kind === 'stale') {
          onDone(item.key, outcome.kind === 'stale' ? 'resolved' : 'merged');
        } else if (outcome.kind === 'pending' || outcome.kind === 'conflict_dispatched') {
          setRetrySafe(false);
          setConfirm(false);
          router.refresh();
          setError(outcome.kind === 'pending' ? outcome.message : 'An agent is resolving the conflicts.');
          return;
        } else {
          setRetrySafe(outcome.kind !== 'indeterminate' || outcome.liveState === 'open');
          setError('message' in outcome ? outcome.message : 'This change needs conflict resolution.');
          setConfirm(false);
          router.refresh();
          return;
        }
      } else {
        if (!res.ok) throw new Error(data.error || 'Could not complete the action.');
        onDone(item.key, label);
      }
      router.refresh();
    } catch (e) { if (merge) setRetrySafe(false); setError(e instanceof Error ? e.message : 'Could not reach the server.'); }
    finally { setBusy(false); }
  }
  let actions: ReactNode;
  if (merge) actions = <><button className={primary} disabled={busy || !!blocked || !retrySafe} onClick={() => confirm ? void act(`/api/prs/${q.prNumber}/merge`, { workspaceId: q.workspaceId }, 'merged') : setConfirm(true)}>{busy ? 'Merging…' : confirm ? 'Confirm merge' : 'Merge'}</button>{confirm ? <button className={secondary} onClick={() => setConfirm(false)}>Cancel</button> : <Link href={q.prUrl ?? item.href} className={secondary}>{q.docFixTaskId ? 'Claims' : 'Review PR'}</Link>}</>;
  else if (q?.humanReview && q.prUrl) actions = <><Link className={primary} href={`${q.prUrl}/files`}>{q.humanReview.label}</Link>{item.details && <Link className={secondary} href={item.details.href}>{item.details.label}</Link>}</>;
  else if (ci) actions = <><button className={primary} disabled={busy} onClick={() => void act(`/api/prs/${q!.prNumber}/retry-ci`, { workspaceId: q!.workspaceId }, 'fix started')}>{busy ? 'Starting…' : 'Start fix'}</button><Link className={secondary} href={q?.prUrl ? `${q.prUrl}/checks` : item.href}>Logs</Link></>;
  else if (item.strand) actions = <><button className={primary} disabled={busy || !!blocked} onClick={() => { recordStrand('continue-on-runner'); void act(`/api/missions/${encodeURIComponent(item.strand!.missionId)}`, { executor: 'runner' }, 'moved to runner', 'PATCH'); }}>{busy ? 'Moving…' : 'Move to runner'}</button><button className={secondary} disabled={busy} onClick={() => { recordStrand('wait-for-local'); onDone(item.key, 'kept local'); }}>Keep local</button></>;
  else if (item.held) actions = <><button className={primary} disabled={busy} onClick={() => void act(`/api/missions/${encodeURIComponent(item.held!.id)}`, { arm: true }, 'started', 'PATCH')}>{busy ? 'Starting…' : 'Start'}</button><Link href={item.href} className={secondary}>Open</Link></>;
  else if (item.question) actions = <><form className="flex w-full flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (reply.trim()) void act(`/api/workers/${encodeURIComponent(item.question!.workerId)}/respond`, { message: reply.trim() }, 'answered'); }}><input aria-label="Your answer" value={reply} onChange={e => setReply(e.target.value)} className="min-h-11 min-w-0 flex-1 border border-border-default bg-transparent px-2 text-body" placeholder="Your answer…" /><button className={primary} disabled={busy || !reply.trim()}>Reply</button></form>{item.question.question.options.slice(0, 4).map(({ label }) => <button key={label} className={secondary} disabled={busy} onClick={() => void act(`/api/workers/${encodeURIComponent(item.question!.workerId)}/respond`, { message: label }, 'answered')}>{label}</button>)}</>;
  else actions = <><Link className={primary} href={item.primary?.href ?? item.href}>{item.primary?.label ?? 'View'}</Link>{item.details && <Link className={secondary} href={item.details.href}>{item.details.label}</Link>}</>;

  // The decision line is one sentence; anything longer folds behind Details.
  const review = q?.humanReview;
  const decision = review ? review.decision ?? firstSentence(review.reason) : firstSentence(item.sentence);
  const detail = review ? review.reason
    : item.systemic && item.systemic.subjects.length > 2 ? `Affects ${item.systemic.subjects.join(', ')}.`
    : item.sentence;
  const status = q?.machineStatus ?? (q?.refreshFirst ? 'Waits on the branch refresh' : null);
  return <article data-testid="needs-you-card" data-kind={item.kind} data-systemic={item.systemic ? 'true' : undefined} className="card-decision flex min-w-0 flex-col p-4">
    <div className="flex items-center justify-between gap-3 text-meta">
      <Eyebrow tone="accent">{sentenceCase(item.systemic ? `Systemic · ${item.label}` : item.label)}</Eyebrow>
      <span className="shrink-0 font-mono text-text-muted">{item.meta}</span>
    </div>
    <h3 className="mt-2 text-title font-semibold text-text-primary [overflow-wrap:anywhere]">{item.title}</h3>
    <ReviewDecision decision={decision} detail={detail} blockers={review?.blockers ?? []} status={status} />
    {q?.mergeAdvice && <MergeAdvice slot={q.mergeAdvice} />}
    <div className="mt-auto flex flex-wrap gap-2 pt-3">{actions}</div>
    {blocked && <p className="mt-2 text-meta text-text-secondary">{blocked}</p>}
    {error && <p role="alert" className="mt-2 text-meta text-status-error">{error}</p>}
  </article>;
}
