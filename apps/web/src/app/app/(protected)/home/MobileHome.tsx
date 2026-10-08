'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { homeAttentionCopy, type HomeAttentionItem } from '@/lib/home-needs-you';
import { admitWaitingTasks } from '@/lib/home-attention';
import { publishHomeAttentionCount } from '@/lib/home-attention-store';
import { useHideNeedsInputBannerOnPhone } from '@/lib/needs-input-hidden';
import { useNeedsInput } from '@/components/needs-input-context';
import { needsInputTaskHref } from '@/components/NeedsInputBanner';
import { resolveMergeOutcome } from '@/lib/merge-outcome';
import type { HomeShippedMission } from './NeedsYouStack';
import { shippedDurationFacts, shippedSummaryHref } from './NeedsYouStack';
import { DeliveryMilestones } from './DeliveryMilestones';
import type { DeliveryCounts, MissionDelivery } from '@/lib/delivery-projection';

const primary = 'inline-flex min-h-11 items-center justify-center border border-border-strong bg-accent px-3 text-body font-semibold text-[var(--on-accent)] disabled:opacity-50';
const secondary = 'inline-flex min-h-11 items-center justify-center border border-border-strong px-3 text-body text-text-primary';
const square = { ink: 'bg-text-primary', warning: 'bg-status-warning', error: 'bg-status-error' };

/** The same frame and action positions for every owner decision. */
function AttentionCard({ item, onDone }: { item: HomeAttentionItem; onDone: (key: string, label: string) => void }) {
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
  else if (item.question) actions = <><form className="flex w-full flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (reply.trim()) void act(`/api/workers/${encodeURIComponent(item.question!.workerId)}/respond`, { message: reply.trim() }, 'answered'); }}><input aria-label="Your answer" value={reply} onChange={e => setReply(e.target.value)} className="min-h-11 min-w-0 flex-1 border border-border-strong bg-transparent px-2 text-lede" placeholder="Your answer…" /><button className={primary} disabled={busy || !reply.trim()}>Reply</button></form>{item.question.question.options.slice(0, 4).map(({ label }) => <button key={label} className={secondary} disabled={busy} onClick={() => void act(`/api/workers/${encodeURIComponent(item.question!.workerId)}/respond`, { message: label }, 'answered')}>{label}</button>)}</>;
  else actions = <><Link className={primary} href={item.primary?.href ?? item.href}>{item.primary?.label ?? 'View'}</Link>{item.details && <Link className={secondary} href={item.details.href}>{item.details.label}</Link>}</>;
  // A systemic cause wears its own edge and word, so it never reads as one more task.
  return <article data-testid="phone-needs-you-card" data-kind={item.kind} data-systemic={item.systemic ? 'true' : undefined} className={`border-2 border-border-strong bg-[var(--chat-surface)] p-4 shadow-[4px_4px_0_var(--border-strong)] ${item.systemic ? 'border-l-[6px] border-l-status-error' : ''}`}>
    <div className="flex items-center justify-between gap-3 text-meta"><span className="flex items-center gap-2"><i aria-hidden="true" className={`h-2 w-2 shrink-0 ${square[item.tone]}`} />{item.systemic ? `systemic · ${item.label}` : item.label}</span><span className="shrink-0 text-text-muted">{item.meta}</span></div>
    <h3 className="mt-3 break-words font-mono text-title font-bold">{item.title}</h3>
    <p className="mt-1 font-convo text-body text-text-secondary">{item.sentence}</p>
    <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
    {blocked && <p className="mt-2 text-meta text-status-warning">{blocked}</p>}
    {error && <p role="alert" className="mt-2 text-meta text-status-error">{error}</p>}
  </article>;
}

export function MobileHome({ items: serverItems, ask, counts, milestones, quietMissions, shipped, timeZone }: {
  items: HomeAttentionItem[]; ask: ReactNode;
  /** The count contracts (lib/delivery-projection.ts `deliveryCounts`). */
  counts: DeliveryCounts;
  /** 2–3 missions moving toward delivery (`selectHomeMilestones`). */
  milestones: MissionDelivery[];
  /** Open missions waiting on capacity, another mission or their owner: named, never listed. */
  quietMissions: number;
  shipped: HomeShippedMission[]; timeZone?: string | null;
}) {
  const [done, setDone] = useState<Record<string, string>>({});
  // Optimism covers only this snapshot. Fresh server truth wins after every refresh.
  useEffect(() => { setDone({}); }, [serverItems]);
  // One list of what needs you: every task the global banner would name is in
  // it, so the banner steps aside on a phone instead of naming a second list.
  const { tasks: waiting } = useNeedsInput();
  const items = useMemo(() => admitWaitingTasks(serverItems, waiting, needsInputTaskHref), [serverItems, waiting]);
  useHideNeedsInputBannerOnPhone(true);
  const open = items.filter(i => !done[i.key]);
  const copy = homeAttentionCopy(open);
  useEffect(() => { publishHomeAttentionCount(copy.count); }, [copy.count]);
  // Systemic causes first and apart: one problem behind many tasks is not a per-task decision.
  const ordered = [...items.filter(i => i.systemic), ...items.filter(i => !i.systemic)];
  const m = shipped[0];
  const agents = `${counts.liveAgents} agent${counts.liveAgents === 1 ? '' : 's'} working`;
  return <div data-testid="phone-home" className="md:hidden text-text-primary">
    <p data-testid="phone-home-counts" className="mb-5 text-body text-text-muted">{agents} · {counts.slots.used}/{counts.slots.total} slots · {counts.openMissions} open mission{counts.openMissions === 1 ? '' : 's'}</p>
    {copy.count === 0
      ? <div className="mb-6"><h1 className="sr-only">Home</h1><p data-testid="phone-all-clear" role="status" className="flex flex-wrap items-baseline gap-x-2 border-b border-border-default py-3 font-voice text-lede"><span aria-hidden="true" className="font-bold text-status-success">✓</span>All clear.<span className="font-convo text-meta text-text-muted">Buildd will ask if a decision comes up.</span></p></div>
      : <><h1 className="font-voice text-display font-medium normal-case tracking-normal">{copy.headline}</h1>
        <p className="mb-6 mt-2 font-voice text-lede italic text-text-secondary">{copy.subline}</p></>}
    {ask}
    {items.length > 0 && <section className="mb-8"><div className="mb-3 flex items-center justify-between"><h2 className="section-label">Needs you</h2><span data-testid="phone-needs-you-count" className="text-meta text-text-muted">{copy.count} open</span></div>
      <div className="space-y-4">{ordered.map(item => done[item.key] ? <p key={item.key} className="flex gap-2 border-b border-border-default py-3 text-body"><i className="mt-1 h-2 w-2 shrink-0 bg-status-success" /><Link href={item.href}>{done[item.key]} · {item.title}</Link></p> : <AttentionCard key={item.key} item={item} onDone={(key, label) => setDone(prev => ({ ...prev, [key]: label }))} />)}</div>
      {quietMissions > 0 && <p data-testid="phone-not-listed" className="mt-2 text-meta text-text-muted">Not listed here: {quietMissions} mission{quietMissions === 1 ? '' : 's'} waiting on capacity, another mission or an owner. {quietMissions === 1 ? 'It moves' : 'Those move'} on {quietMissions === 1 ? 'its' : 'their'} own.</p>}
    </section>}
    {m && <section className="mb-8"><h2 className="section-label mb-3">Just shipped</h2><article className="border border-border-default bg-[var(--chat-surface)] p-4"><div className="flex justify-between gap-2 text-meta"><span className="flex items-center gap-2 text-status-success"><i className="h-2 w-2 bg-status-success" />shipped {new Date(m.completedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })}</span>{m.criteria && <span>{m.criteria.passed}/{m.criteria.total} criteria</span>}</div><h3 className="mt-3 text-title font-bold">{m.title}</h3><dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border-default pt-3">{[[m.prs, 'PRs merged'], ...shippedDurationFacts(m)].slice(0, 3).map(([value, label]) => <div key={label}><dt className="text-meta text-text-muted">{label}</dt><dd className="text-heading">{value}</dd></div>)}</dl><Link className="mt-3 inline-flex min-h-11 items-center text-body" href={shippedSummaryHref(m.href)}>Read summary →</Link></article></section>}
    <DeliveryMilestones missions={milestones} openMissions={counts.openMissions} />
    <Link href="/app/tasks" className="inline-flex min-h-11 items-center text-body text-text-secondary">See everything in motion in Activity →</Link>
  </div>;
}
