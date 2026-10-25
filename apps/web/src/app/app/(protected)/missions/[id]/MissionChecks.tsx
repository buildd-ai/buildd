'use client';

/**
 * Mission · Overview after the build: the Build / Verify / Deliver rail, the
 * Build complete bar and the checks that apply (spec f7f67f1a R-11 to R-22).
 *
 * ```
 * Build ✓   Verify   Deliver              rail: which checkpoint it waits on
 * ┌ ■■■■■■■■ Build complete · 10 of 10 in mission/x   Show tasks ┐
 * Checks
 * │ ◔ Visual review  blocks merge            capturing 6 of 8 │
 * │ ○ Mission PR #128 into dev                       waiting  │
 * │ ○ Unit tests pass  goal                       after merge │
 * ```
 *
 * Rows come from `missionChecks` (lib/mission-checks.ts); this file only
 * draws them. The owner's buttons stay where they already are (the visual
 * review ask, the mission PR): a row says who acts next, it adds no second
 * Approve or Merge button (R-21).
 */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Card from '@/components/ui/Card';
import CheckRowView, { CheckIcon } from '@/components/ui/CheckRow';
import type { DeliveryCheckView, DeliveryView } from '@/lib/mission-delivery-checks';
import { VISUAL_REVIEW_SKIP_REASONS, type VisualReviewSkipReason } from '@buildd/core/surface-audit';
import { saveSurfaceAuditWaiver, useSurfaceAuditWaiver } from './MissionSurfaceAuditWaiver';
import type { CheckRow, CheckStatus, OutcomeSpecLine, RailStep } from '@/lib/mission-checks';
import type { CriterionLine } from '@/lib/mission-outcome-spec-view';
import { buildFoldLine } from '@/lib/mission-build-stage';
import type { StandardItemStatus, StandardsLine } from '@/lib/specs/mission-standards-gate';

/** Build's count without its trailing word: `11 of 16 done` reads `Build · 11 of 16`. */
const stageCount = (text: string) => text.replace(/\s+done$/, '');

/**
 * The stage line, `Build · 11 of 16   Verify   Deliver` (Navigation R-3,
 * R-15): one line of text that says which checkpoint the mission waits on
 * (R-13), no progress segments. The current stage is bold (Build with its
 * count); a finished one is its word and a tick; one not started is one
 * word, never a card. A held stage says why in the error hue.
 */
export function CheckRail({ steps }: { steps: readonly RailStep[] }) {
  // The current stage: the first not finished, else the last (delivered).
  const current = steps.find(s => s.state !== 'done')?.key ?? steps[steps.length - 1]?.key;
  return (
    <ol data-testid="mission-check-rail" aria-label="Build, Verify, Deliver" className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border-default pb-2 text-body md:gap-x-7 md:pb-3">
      {steps.map(s => {
        const isCurrent = s.key === current;
        const tone = s.state === 'held' ? 'text-status-error' : s.state === 'done' ? 'text-status-success' : isCurrent ? 'text-text-primary' : 'text-text-muted';
        const detail = s.state === 'held' ? s.text : isCurrent && s.key === 'build' && s.state !== 'done' ? stageCount(s.text) : null;
        return (
          <li key={s.key} data-step={s.key} data-state={s.state} aria-current={isCurrent && s.state !== 'done' ? 'step' : undefined} className={`min-w-0 ${tone}`}>
            <span data-testid="mission-stage-label" className={isCurrent ? 'font-semibold' : ''}>{s.state === 'done' ? `${s.label} ✓` : s.label}</span>
            {detail && <span data-testid="mission-check-rail-text" className={`[overflow-wrap:anywhere] ${s.state === 'held' ? '' : 'text-text-muted'}`}>{` · ${detail}`}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The one spec line under the goal (Navigation R-3): `Spec <name>` linking to
 * the spec, no count; several selected specs read `Specs <a>, <b>`.
 */
export function OutcomeSpecLines({ lines }: { lines: readonly OutcomeSpecLine[] }) {
  if (lines.length === 0) return null;
  return (
    <p data-testid="mission-outcome-spec" className="flex min-w-0 items-baseline gap-x-1.5 text-meta">
      <span className="shrink-0 text-text-muted">{lines.length === 1 ? 'Spec' : 'Specs'}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {lines.map((l, i) => (
          <span key={l.specId} data-testid="mission-outcome-spec-line">
            {i > 0 && <span className="text-text-muted">, </span>}
            <a href={l.href} title={l.title} className="text-accent-text underline decoration-border-strong underline-offset-2 hover:decoration-current">{l.title}</a>
          </span>
        ))}
      </span>
    </p>
  );
}

const STANDARD_STATUS: Record<StandardItemStatus, string> = { met: 'met', not_met: 'not met', checking: 'checking', not_checked: 'not checked' };

/**
 * Verify's Standards line (Navigation R-17): CI and code review beside the
 * mission's standards, one line that opens on its own only when one is not met.
 */
export function StandardsLineView({ line }: { line: StandardsLine }) {
  return (
    <details data-testid="mission-standards" open={line.open} className="text-body">
      <summary className="flex min-h-11 cursor-pointer items-baseline gap-x-2 md:min-h-0">
        <span className="shrink-0 text-text-muted">Standards</span>
        <span data-testid="mission-standards-summary" className={`font-mono text-meta ${line.open ? 'text-status-error' : 'text-text-muted'}`}>{line.text}</span>
      </summary>
      <ul aria-label="Standards" className="mt-1 flex flex-col gap-1 pl-4">
        {line.items.map(it => (
          <li key={it.key} data-testid="mission-standards-item" data-status={it.status} className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap">
            {it.href
              ? <a href={it.href} title={it.label} className="min-w-0 truncate text-text-primary underline-offset-4 hover:underline">{it.label}</a>
              : <span className="min-w-0 truncate text-text-primary">{it.label}</span>}
            <span className="shrink-0 font-mono text-meta text-text-muted">{STANDARD_STATUS[it.status]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The folded Build stage once every build task landed (Navigation R-15):
 * one line, `16 tasks merged ›`, that opens the bar. Never says delivered (R-12).
 */
export function BuildCompleteBar({ done, where, open, onToggle, children }: { done: number; where: string; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Card data-testid="build-complete-bar" padding="sm" className="flex flex-wrap items-center gap-x-4 gap-y-2 md:px-4">
        <span aria-hidden="true" className="state-cell inline-block h-3.5 w-3.5 shrink-0 rounded-[var(--radius-cell)]" data-tone="ok" data-pattern="solid" />
        <button type="button" aria-expanded={open} data-testid="build-complete-toggle" onClick={onToggle} title={`${done} of ${done} in ${where}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-title font-medium text-text-primary md:min-h-0">
          {buildFoldLine(done)}
        </button>
      </Card>
      {open && children}
    </div>
  );
}

const STATE_TONE: Record<CheckStatus, string> = {
  passed: 'text-status-success',
  running: 'text-accent-text',
  finding: 'text-status-error',
  unable: 'text-status-warning',
  owner: 'text-text-primary',
  stale: 'text-status-warning',
  queued: 'text-text-muted',
  waived: 'text-text-muted',
  not_applicable: 'text-text-muted',
};

/** One glyph per status, so a row reads without colour: tick, ring, cross, bang, dashed circle. */
function Glyph({ status }: { status: CheckStatus }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true, fill: 'none', strokeWidth: 1.6 } as const;
  switch (status) {
    case 'passed':
      return <svg {...common} className="text-status-success" stroke="currentColor"><circle cx="9" cy="9" r="7.5" /><path d="M5.5 9.2l2.3 2.3 4.7-4.9" /></svg>;
    case 'running':
      return <svg {...common} className="text-accent-text" stroke="currentColor"><circle cx="9" cy="9" r="7.5" opacity=".35" /><path d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" /></svg>;
    case 'finding':
      return <svg {...common} className="text-status-error" stroke="currentColor"><circle cx="9" cy="9" r="7.5" /><path d="M6.3 6.3l5.4 5.4M11.7 6.3l-5.4 5.4" /></svg>;
    case 'unable':
    case 'stale':
      return <svg {...common} className="text-status-warning" stroke="currentColor"><circle cx="9" cy="9" r="7.5" /><path d="M9 5v5" /><circle cx="9" cy="12.8" r=".6" fill="currentColor" /></svg>;
    case 'owner':
      return <svg {...common} className="text-text-primary" stroke="currentColor"><circle cx="9" cy="9" r="7.5" /><circle cx="9" cy="9" r="2.5" fill="currentColor" /></svg>;
    case 'waived':
    case 'not_applicable':
      return <svg {...common} className="text-text-muted" stroke="currentColor"><circle cx="9" cy="9" r="7.5" /><path d="M5.5 9h7" /></svg>;
    default:
      return <svg {...common} className="text-text-muted" stroke="currentColor" strokeDasharray="2.5 2.5"><circle cx="9" cy="9" r="7.5" /></svg>;
  }
}

const RESULT_TONE: Record<CriterionLine['result'], string> = {
  passed: 'text-status-success', failed: 'text-status-error', 'not checked': 'text-text-muted', 'out of date': 'text-status-warning', waived: 'text-text-muted',
};

/** A spec row's requirements: each in its own words with its result; the id is a small secondary label. */
export function CriterionLines({ lines }: { lines: readonly CriterionLine[] }) {
  return (
    <ul data-testid="mission-check-criteria" aria-label="Requirements" className="col-start-2 mt-1 flex flex-col gap-2 md:col-[2/4]">
      {lines.map(l => (
        <li key={l.id} data-testid="mission-check-criterion" data-result={l.result} className="flex min-w-0 flex-col gap-0.5 text-body">
          <span className="text-text-primary [overflow-wrap:anywhere]">{l.text ?? l.id}</span>
          <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-meta">
            <span className={RESULT_TONE[l.result]}>{l.result}</span>
            {l.reason && <span className="text-text-secondary">{l.reason}</span>}
            {l.text && <span data-testid="mission-check-criterion-id" className="text-chip text-text-muted">{l.id}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const LIVE: ReadonlySet<CheckStatus> = new Set(['running', 'finding', 'owner', 'unable', 'stale']);

/** A finding's repair tasks, shown inside their check (I-6), never in the build count. */
function RepairList({ repairs, onOpenTask }: { repairs: readonly { id: string; title: string; done: boolean }[]; onOpenTask?: (id: string) => void }) {
  return (
          <ul data-testid="mission-check-repairs" aria-label="Fixes" className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border-l-2 border-status-error px-3 py-2 [background:var(--inset)]">
            {repairs.map(f => (
              <li key={f.id} className="flex min-w-0 items-center gap-2.5 text-body">
                <span aria-hidden="true" className="state-cell inline-block h-3.5 w-3.5 shrink-0 rounded-[var(--radius-cell)]" data-tone={f.done ? 'ok' : 'act'} data-pattern={f.done ? 'solid' : 'hatch-bold'} />
                {onOpenTask
                  ? <button type="button" onClick={() => onOpenTask(f.id)} className="min-h-11 min-w-0 text-left md:min-h-0 text-text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]">{f.title}</button>
                  : <span className="min-w-0 text-text-primary [overflow-wrap:anywhere]">{f.title}</span>}
                <span className="ml-auto shrink-0 font-mono text-meta text-text-muted">{f.done ? 'merged' : 'fixing'}</span>
              </li>
            ))}
          </ul>
  );
}

/**
 * Delivery beside Checks (spec 072de598 I-20 to I-24). Delivery is one mono
 * count line, a row per PR and `Timeline ›`; Checks are Visual review, Merge
 * into dev and Release as CheckRows, stacked on a phone and three steps side
 * by side on desktop with the current one marked. Labels, never sentences;
 * a part with nothing to show renders nothing.
 */
export function DeliveryChecks({ checks, delivery, timelineHref, onOpenTask }: { checks: readonly DeliveryCheckView[]; delivery: DeliveryView | null; timelineHref: string; onOpenTask?: (id: string) => void }) {
  const [skipping, setSkipping] = useState<string | null>(null);
  if (checks.length === 0 && !delivery) return null;
  return (
    <SkipContext.Provider value={{ skipping, setSkipping }}>
      <section data-testid="mission-delivery-checks" className={`grid min-w-0 gap-5 ${delivery && checks.length > 0 ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
        {delivery && (
          <div data-testid="mission-delivery" className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-meta text-text-muted">Delivery</h2>
              {delivery.line && <p data-testid="mission-delivery-line" className="font-mono text-meta text-text-secondary">{delivery.line}</p>}
            </div>
            {delivery.prs.length > 0 && (
              <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
                {delivery.prs.map(p => {
                  const body = (
                    <>
                      <CheckIcon status={p.status} />
                      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{p.title}</span>
                      {p.number != null && <span className="shrink-0 font-mono text-meta text-text-muted">#{p.number}</span>}
                    </>
                  );
                  const cls = 'flex min-h-11 min-w-0 items-center gap-2.5 px-3 md:min-h-9';
                  return (
                    <li key={p.key} data-testid="mission-delivery-pr" data-status={p.status} className="border-t border-[var(--line-soft)] first:border-t-0">
                      {p.href ? <a href={p.href} target="_blank" rel="noopener noreferrer" className={`${cls} hover:bg-card-hover`}>{body}</a> : <div className={cls}>{body}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
            <a href={timelineHref} data-testid="mission-delivery-timeline" className="flex min-h-11 items-center justify-between font-mono text-meta text-text-secondary hover:text-text-primary md:min-h-9"><span>Timeline</span> <span aria-hidden="true">›</span></a>
          </div>
        )}
        {checks.length > 0 && (
          <div data-testid="mission-checks" className="flex min-w-0 flex-col gap-2">
            <h2 className="text-meta text-text-muted">Checks</h2>
            <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card md:grid md:overflow-visible md:border-0 md:bg-transparent md:[grid-template-columns:repeat(var(--steps),minmax(0,1fr))] md:gap-3" style={{ '--steps': checks.length } as React.CSSProperties}>
              {checks.map(c => (
                <li key={c.key} data-testid="mission-check" data-kind={c.key} data-status={c.status} data-current={c.current || undefined} className="border-t border-[var(--line-soft)] first:border-t-0 md:rounded-[var(--radius-card)] md:border md:border-border-default md:bg-card md:first:border-t">
                  <CheckRowView
                    name={c.name}
                    status={c.status}
                    stateWord={c.stateWord}
                    detail={c.detail}
                    href={c.href}
                    current={c.current}
                    steps
                    action={c.skippable ? <CheckSkip.Trigger row={c.key} /> : undefined}
                  />
                  {c.skippable && <div className="px-3 pb-3"><CheckSkip.Form row={c.key} /></div>}
                  {c.repairs.length > 0 && <div className="px-3 pb-3"><RepairList repairs={c.repairs} onOpenTask={onOpenTask} /></div>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </SkipContext.Provider>
  );
}

/** The goal criteria, one row each (R-16). */
export function ChecksCard({ rows, onOpenTask }: { rows: readonly CheckRow[]; onOpenTask?: (id: string) => void }) {
  const [skipping, setSkipping] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <SkipContext.Provider value={{ skipping, setSkipping }}>
    <section data-testid="mission-checks" aria-labelledby="mission-checks-title" className="flex flex-col gap-2">
      <h2 id="mission-checks-title" className="text-meta text-text-muted">Goals</h2>
      <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {rows.map(r => (
          <li
            key={r.key}
            data-testid="mission-check"
            data-kind={r.kind}
            data-status={r.status}
            data-blocks={r.blocks || undefined}
            data-problem={r.problem ?? undefined}
            className={`grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--line-soft)] px-3 py-3 first:border-t-0 md:grid-cols-[22px_minmax(0,1fr)_auto] md:px-4 md:py-3.5 ${LIVE.has(r.status) ? 'shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
          >
            <span className="row-span-2 pt-px md:row-span-2"><Glyph status={r.status} /></span>
            <span className="min-w-0 text-title [overflow-wrap:anywhere]">
              {r.href
                ? <a href={r.href} data-testid="mission-check-link" className="inline-flex min-h-11 items-center font-medium text-text-primary underline decoration-border-strong underline-offset-4 hover:decoration-current md:min-h-0">{r.label}</a>
                : <span className="font-medium text-text-primary">{r.label}</span>}
              {r.chip && <span className="ml-2 inline-block rounded px-1.5 align-[1px] font-mono text-chip text-text-muted [background:var(--q-tint)]">{r.chip}</span>}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-3 md:justify-end">
              <span data-testid="mission-check-state" className={`font-mono text-meta ${STATE_TONE[r.status]}`}>
                {r.state}
                {r.commit && <span className="ml-2 text-text-muted">{r.commit}</span>}
              </span>
              {r.waivable && <CheckSkip.Trigger row={r.key} />}
            </span>
            {r.detail && <span className="col-start-2 text-body text-text-secondary md:col-[2/4]">{r.detail}</span>}
            {r.criteria && r.criteria.length > 0 && <CriterionLines lines={r.criteria} />}
            {r.waivable && <CheckSkip.Form row={r.key} />}
            {(r.repairs.length > 0 || r.evidence.length > 0) && (
              <div className="col-start-2 mt-1 flex flex-col gap-2 md:col-[2/4]">
                {r.repairs.length > 0 && <RepairList repairs={r.repairs} onOpenTask={onOpenTask} />}
                {r.evidence.length > 0 && (
                  <p className="flex flex-wrap gap-x-4 font-mono text-meta">
                    {r.evidence.map(e => (
                      <a key={e.href} href={e.href} className="inline-flex min-h-11 items-center text-text-secondary md:min-h-0 underline-offset-4 hover:text-text-primary hover:underline">{e.label}</a>
                    ))}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
    </SkipContext.Provider>
  );
}

// ── Skip (spec 072de598 I-7) ──────────────────────────────────────────────────

const SkipContext = createContext<{ skipping: string | null; setSkipping: (key: string | null) => void }>({ skipping: null, setSkipping: () => {} });

/**
 * Skip on a check a person may waive: one word beside the status, then two
 * buttons in place, an optional note, no minimum length. Either button
 * records the waiver in one tap (PATCH surfaceAuditWaiver); the row then
 * reads waived, never passed, and holds until a person withdraws it.
 * Offered only on a mission page, to a person, while the mission is open.
 */
const CheckSkip = {
  Trigger({ row }: { row: string }) {
    const ctx = useSurfaceAuditWaiver();
    const { skipping, setSkipping } = useContext(SkipContext);
    if (!ctx || ctx.readonly || ctx.waiver) return null;
    const open = skipping === row;
    return (
      <button
        type="button"
        data-testid="mission-check-skip"
        aria-expanded={open}
        onClick={() => setSkipping(open ? null : row)}
        className="inline-flex min-h-11 items-center font-mono text-meta text-text-secondary underline underline-offset-4 hover:text-text-primary md:min-h-0"
      >
        Skip
      </button>
    );
  },
  Form({ row }: { row: string }) {
    const ctx = useSurfaceAuditWaiver();
    const { skipping, setSkipping } = useContext(SkipContext);
    const router = useRouter();
    const noteId = useId();
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState<VisualReviewSkipReason | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (!ctx || ctx.readonly || ctx.waiver || skipping !== row) return null;
    async function submit(reason: VisualReviewSkipReason) {
      setSaving(reason);
      setError(null);
      const out = await saveSurfaceAuditWaiver(ctx!.missionId, { reason, note: note.trim() || null });
      setSaving(null);
      if (!out.ok) { setError(out.error); return; }
      setSkipping(null);
      router.refresh();
    }
    return (
      <form
        data-testid="mission-check-skip-form"
        className="col-start-2 mt-1 flex flex-col gap-2 md:col-[2/4]"
        onSubmit={e => e.preventDefault()}
      >
        <label htmlFor={noteId} className="text-meta text-text-secondary">Why skip it? Optional. Either button below skips right away.</label>
        <textarea
          id={noteId}
          value={note}
          onChange={e => { setNote(e.target.value); if (error) setError(null); }}
          rows={2}
          data-testid="mission-check-skip-note"
          placeholder="Add detail, if it helps"
          className="block w-full min-w-0 resize-none bg-surface-1 px-2 py-1.5 text-body text-text-primary"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!!saving}
            onClick={() => submit('wrong_or_stuck')}
            data-testid="mission-check-skip-wrong"
            className="btn btn-primary h-11 md:h-9"
          >
            {saving === 'wrong_or_stuck' ? 'Skipping…' : VISUAL_REVIEW_SKIP_REASONS.wrong_or_stuck}
          </button>
          <button
            type="button"
            disabled={!!saving}
            onClick={() => submit('ship_anyway')}
            data-testid="mission-check-skip-ship"
            className="btn h-11 md:h-9"
          >
            {saving === 'ship_anyway' ? 'Skipping…' : VISUAL_REVIEW_SKIP_REASONS.ship_anyway}
          </button>
          <button type="button" disabled={!!saving} data-testid="mission-check-skip-cancel" onClick={() => setSkipping(null)} className="btn btn-quiet h-11 md:h-9">Cancel</button>
        </div>
        {error && <p role="alert" className="font-mono text-meta text-status-error [overflow-wrap:anywhere]">{error}</p>}
      </form>
    );
  },
};
