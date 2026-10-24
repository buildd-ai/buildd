'use client';

import type { NowState } from './task-activity';
import { useEffect, useRef, useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import Lifecycle from '@/components/ui/Lifecycle';
import type { StateKey } from '@/components/ui/states';
import { collapseWorkspacePath, ageLabel } from './WorkerActivityTimeline';
import type { RunStall } from '@/lib/run-stall';

type Phase = NowState['evidence']['phases'][number];

const isWeak = (p: Phase) => p.source === 'reported' || p.source === 'inferred';

const phaseTone = (p: Phase) =>
  p.state === 'failed' ? 'text-status-error' : p.state === 'current' ? 'text-accent-text' : p.state === 'done' ? 'text-text-primary' : 'text-text-muted';

const phaseName = (p: Phase) =>
  `${p.label}, ${p.state}, ${isWeak(p) ? 'reported' : p.source}${p.subState ? `, ${p.subState}` : ''}`;

/** The phase the run is at: the live one, else the last failed or done one. */
export function headPhase(phases: readonly Phase[]): { phase: Phase; index: number } | null {
  let i = phases.findIndex(p => p.state === 'current');
  if (i < 0) i = phases.findLastIndex(p => p.state === 'failed');
  if (i < 0) i = phases.findLastIndex(p => p.state === 'done');
  return i < 0 ? null : { phase: phases[i], index: i };
}

/**
 * The run's evidence read as a state on the one Build → Verify → Deliver track.
 * The phases stay the evidence (behind the disclosure); this only says which
 * step they add up to. `paused` is the waiting-on-an-answer bar.
 */
export function runLifecycleState(phases: readonly Phase[], { paused = false }: { paused?: boolean } = {}): StateKey {
  const at = (key: string) => phases.find(p => p.key === key);
  const merged = at('merged');
  const delivered = at('delivered');
  const pr = at('pr_open');
  const ci = at('ci');
  const review = at('review');
  if (merged?.state === 'done' || delivered?.state === 'done') return 'landed';
  if (pr?.state === 'failed') return 'not_landed';
  if (review?.state === 'failed') {
    return review.subState === 'escalated' ? 'needs_you' : review.subState === 'review_failed' ? 'recovering' : 'fixing';
  }
  if (ci?.state === 'failed' && ci.subState === 'failed') return 'ci_failed';
  if (review?.state === 'done') return 'landing';
  if (pr?.state === 'done') return paused ? 'needs_you' : 'review';
  return paused ? 'waiting' : 'running';
}

type MarkerKind = 'done' | 'reported' | 'current' | 'failed' | 'todo' | 'unknown';

const markerKind = (p: Phase): MarkerKind =>
  p.state === 'done' ? (isWeak(p) ? 'reported' : 'done') : p.state === 'skipped' ? 'todo' : p.state;

/**
 * One shape per kind, so the list reads without colour: solid (done), framed
 * with an inner fill (reported), haloed (live), crossed (failed, the ⊠ glyph),
 * outline (not yet), dashed (not seen). Cells on the 3px cell radius.
 */
const MARKER: Record<MarkerKind, string> = {
  done: 'bg-status-success',
  reported: 'bg-card ring-1 ring-inset ring-status-success',
  current: 'bg-status-running ring-[3px] ring-primary-ring animate-status-pulse motion-reduce:animate-none',
  failed: 'bg-card ring-1 ring-inset ring-status-error',
  todo: 'bg-card ring-1 ring-inset ring-[var(--faint)]',
  unknown: 'bg-card border border-dashed border-[var(--faint)]',
};

/**
 * Odd sizes in an odd-width column, so every marker and the 1px axis share
 * one centre on a whole pixel: the current step 15px, every other step 11px.
 */
function EvidenceMarker({ kind, head }: { kind: MarkerKind; head: boolean }) {
  return (
    <span aria-hidden="true" data-testid="run-evidence-marker" data-kind={kind}
      className={`relative z-10 block rounded-sm ${head ? 'w-[15px] h-[15px]' : 'w-[11px] h-[11px]'} ${MARKER[kind]}`}>
      {kind === 'reported' && <span className={`absolute bg-status-success ${head ? 'inset-1' : 'inset-[3px]'}`} />}
      {kind === 'failed' && (
        <>
          <span className="absolute left-1/2 top-0.5 bottom-0.5 w-px -translate-x-1/2 rotate-45 bg-status-error" />
          <span className="absolute left-1/2 top-0.5 bottom-0.5 w-px -translate-x-1/2 -rotate-45 bg-status-error" />
        </>
      )}
    </span>
  );
}

/**
 * What the evidence says about the current step, in the words the list
 * already uses: its state (the catalog's "working" while live, else done or
 * its sub-state) and where the fact came from.
 */
export function headWords(p: Phase): string {
  const state = p.subState ? p.subState.replaceAll('_', ' ') : p.state === 'current' ? 'working' : p.state;
  if (p.state === 'current') return state;
  return `${state} · ${isWeak(p) ? 'reported' : p.source}`;
}

type Tier = 'history' | 'head' | 'future';

/** Label tone per tier: the head carries the state hue, history is ink, the future is muted. */
const labelTone = (p: Phase, tier: Tier) =>
  p.state === 'failed' ? 'text-status-error'
    : tier === 'head' ? (p.state === 'current' ? 'text-accent-text' : 'text-text-primary')
    : tier === 'history' && p.state === 'done' ? 'text-text-primary' : 'text-text-muted';

/**
 * Where the run is: the one `Lifecycle` track, then the labelled phase list
 * with times behind a 44px disclosure (closed by default, at every width).
 *
 * Open, the list reads in three tiers on one 1px axis: compact history, the
 * current step (the head phase, larger, with what the evidence says about it),
 * then the steps still to come, muted. Times sit in a fixed left column,
 * right-aligned in tabular figures, so they line up down the axis. A phase
 * with no evidence says "not seen"; a reported one says "reported". Rows are
 * not tap targets, so they stay compact; the toggle is the 44px target.
 */
export function RunEvidenceRail({ evidence, nowMs, paused = false, defaultOpen = false }: { evidence: NowState['evidence']; nowMs?: number; paused?: boolean; defaultOpen?: boolean }) {
  const phases = evidence.phases.filter(p => p.state !== 'skipped');
  const head = headPhase(phases);
  return (
    <div data-testid="run-evidence-rail" className="mt-3 flex flex-col gap-1">
      <Lifecycle state={runLifecycleState(phases, { paused })} />
      <Disclosure
        defaultOpen={defaultOpen}
        summary={
          <span data-testid="run-evidence-head" className="font-mono text-meta text-text-secondary truncate">
            Run evidence · {head ? (
              <><b className={`font-semibold ${phaseTone(head.phase)}`}>{head.phase.label}{head.phase.subState ? ` (${head.phase.subState.replaceAll('_', ' ')})` : ''}</b> · step {head.index + 1} of {phases.length}</>
            ) : (
              <>none yet · {phases.length} phases</>
            )}
          </span>
        }
      >
        <ol data-testid="run-evidence-list" className="mt-1 mb-2 font-mono text-meta">
          {phases.map((p, i) => {
            const tier: Tier = head && i === head.index ? 'head' : head && i > head.index ? 'future' : 'history';
            const isHead = tier === 'head';
            // The axis runs from the first marker's centre to the last one's;
            // the head's marker sits 8px lower, under its taller first line.
            const centre = isHead ? 'top-[22px]' : 'top-3.5';
            const reach = isHead ? 'h-[22px]' : 'h-3.5';
            const first = i === 0;
            const last = i === phases.length - 1;
            const time = p.at != null && nowMs != null ? `${ageLabel(nowMs - p.at)} ago` : '';
            return (
              <li key={p.key} data-phase={p.key} data-state={p.state} data-source={p.source} data-tier={tier} aria-label={phaseName(p)}
                aria-current={p.state === 'current' ? 'step' : undefined}
                className={`grid grid-cols-[56px_15px_minmax(0,1fr)] gap-x-3 ${isHead ? 'items-start' : 'h-7 items-center'}`}>
                <span data-testid="run-evidence-time" suppressHydrationWarning
                  className={`text-right tabular-nums whitespace-nowrap text-text-muted ${isHead ? 'mt-2 h-7 leading-7' : ''}`}>
                  {time}
                </span>
                <span className="relative self-stretch flex justify-center">
                  {!(first && last) && (
                    <span aria-hidden="true" data-testid="run-evidence-axis"
                      className={`absolute left-[7px] w-px bg-border-strong ${first ? `${centre} bottom-0` : last ? `top-0 ${reach}` : 'top-0 bottom-0'}`} />
                  )}
                  <span className={`flex items-center ${isHead ? 'mt-2 h-7' : ''}`}>
                    <EvidenceMarker kind={markerKind(p)} head={isHead} />
                  </span>
                </span>
                {isHead ? (
                  <span data-testid="run-evidence-current" className="min-w-0 py-2">
                    <span className={`block h-7 leading-7 truncate text-title font-semibold ${labelTone(p, tier)}`}>{p.label}</span>
                    <span data-testid="run-evidence-current-words" className="block truncate text-text-secondary">{headWords(p)}</span>
                  </span>
                ) : (
                  <span className={`truncate ${labelTone(p, tier)}`}>
                    {p.label}
                    {p.subState && <span className="text-text-secondary"> · {p.subState.replaceAll('_', ' ')}</span>}
                    {p.state === 'failed' && !p.subState && <span className="text-text-secondary"> · failed</span>}
                    {isWeak(p) && <span className="text-text-muted"> · reported</span>}
                    {p.state === 'unknown' && <span className="text-text-muted"> · not seen</span>}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </Disclosure>
    </div>
  );
}

/** The narration headline: wraps anywhere, three lines at most until "more". */
function Headline({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !full) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, full]);
  return (
    <>
      <p ref={ref} data-testid="worker-now-headline"
        className={`mt-2 text-heading font-semibold leading-snug text-text-primary [overflow-wrap:anywhere] ${full ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      {(clipped || full) && (
        <button type="button" onClick={() => setFull(f => !f)} aria-expanded={full} data-testid="worker-now-headline-more"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:mt-1 text-left font-mono text-chip text-text-secondary hover:text-text-primary">
          {full ? 'less' : 'more'}
        </button>
      )}
    </>
  );
}

/**
 * The live hero: what the agent is doing right now, which lifecycle facts have been observed.
 *
 * `inline` is the task page's Now line inside its one live block (design
 * 6356e80d `phone-task-running`): its age, then one line of body text and the
 * file path. No card and no track: the status line under the title says where
 * the run is.
 */
export default function NowStrip({ now, nowMs, stall = null, variant = 'card' }: { now: NowState; nowMs: number; stall?: RunStall | null; variant?: 'card' | 'inline' }) {
  if (variant === 'inline') {
    const headline = now.headline ? collapseWorkspacePath(now.headline) : 'Waiting for the first update';
    return (
      <div data-testid="worker-now-strip" className="min-w-0 flex-1 basis-[360px]">
        <div data-testid="worker-current-action" className="flex flex-col gap-1">
          <p className={`text-meta ${stall ? 'text-status-warning' : 'text-text-muted'}`} suppressHydrationWarning>
            Now{now.updatedTs != null && ` · updated ${ageLabel(nowMs - now.updatedTs)} ago`}
          </p>
          {stall && (
            <p data-testid="worker-stall" className="text-meta text-status-warning" suppressHydrationWarning>{stall.label}</p>
          )}
          <p data-testid="worker-now-headline" title={headline} className="truncate text-body text-text-primary">
            {headline}
          </p>
          {now.detail && (
            <p data-testid="worker-now-path" className="font-mono text-meta text-text-secondary [overflow-wrap:anywhere]">
              {collapseWorkspacePath(now.detail.target)}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <section
      data-testid="worker-now-strip"
      className="card px-4 py-4 md:px-6 md:py-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1" data-testid="worker-current-action">
          <div className="flex items-center gap-2 font-mono text-chip font-semibold text-accent-text">
            <span className="w-[9px] h-[9px] rounded-sm bg-accent animate-status-pulse motion-reduce:animate-none" aria-hidden="true" />
            Now
            {now.updatedTs != null && (
              <span className={`font-normal ${stall ? 'text-status-warning' : 'text-text-muted'}`} suppressHydrationWarning>
                · updated {ageLabel(nowMs - now.updatedTs)} ago
              </span>
            )}
          </div>
          {stall && (
            <p data-testid="worker-stall" className="mt-1 font-mono text-meta text-status-warning" suppressHydrationWarning>
              {stall.label}
            </p>
          )}
          <Headline text={now.headline ? collapseWorkspacePath(now.headline) : 'Waiting for the first update'} />
          {now.detail && (
            <p className="mt-1.5 font-mono text-meta text-text-secondary truncate">
              {now.detail.verb} <code className="text-text-primary">{collapseWorkspacePath(now.detail.target)}</code>
              {now.detail.recentEdits > 1 && ` · ${now.detail.recentEdits} edits in the last minute`}
            </p>
          )}
        </div>

      </div>
      <RunEvidenceRail evidence={now.evidence} nowMs={nowMs} />
    </section>
  );
}

/** Waiting-state stand-in for the Now strip: where the agent paused, dimmed. */
export function PausedBar({ evidence, elapsed, turns, tokens, nowMs }: { evidence?: NowState['evidence']; elapsed: string | null; turns: number; tokens: string | null; nowMs?: number }) {
  return (
    <div data-testid="worker-paused-bar" className="card px-4 py-3 md:px-6 md:py-4">
      <div className="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-3">
        <span className="font-mono text-chip text-text-muted whitespace-nowrap">
          Paused
        </span>
        <span className="ml-auto font-mono text-chip text-text-muted whitespace-nowrap tabular-nums">
          {elapsed && <><b className="text-text-primary font-semibold">{elapsed}</b> · </>}
          {turns} turns
          {tokens && <span className="hidden md:inline"> · {tokens} tok</span>}
        </span>
      </div>
      {evidence && <RunEvidenceRail evidence={evidence} nowMs={nowMs} paused />}
    </div>
  );
}
