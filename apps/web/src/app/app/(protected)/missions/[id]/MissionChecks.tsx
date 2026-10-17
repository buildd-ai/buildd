'use client';

/**
 * Mission · Overview after the build: the Build / Verify / Deliver rail, the
 * Build complete bar and the checks that apply (spec f7f67f1a R-11 to R-22).
 *
 * ```
 * ━━━━━━━━━  ━━━━━━━━━  ─────────
 * Build      Verify     Deliver           rail: which checkpoint it waits on
 * 10 of 10   capturing  after visual review
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
import { SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH } from '@buildd/core/surface-audit';
import { saveSurfaceAuditWaiver, useSurfaceAuditWaiver } from './MissionSurfaceAuditWaiver';
import type { CheckRow, CheckStatus, OutcomeSpecLine, RailStep } from '@/lib/mission-checks';

// The active stage is live work, so it takes the running hue, never ink beside
// green (R-35): ink and green merge in low light. It is also thicker, so the
// stages read apart in greyscale.
const RAIL_BAR: Record<RailStep['state'], string> = {
  done: 'bg-status-success',
  now: 'bg-status-running',
  part: 'bg-[linear-gradient(90deg,var(--status-success)_0_50%,var(--border-strong)_50%)]',
  // Held is dashed as well as red, so in greyscale it never reads as the active stage.
  held: 'bg-[repeating-linear-gradient(90deg,var(--status-error)_0_6px,transparent_6px_10px)]',
  todo: 'bg-border-strong',
};

/** Which checkpoint the mission waits on (R-13). Equal thirds: widths are not time (R-24). */
export function CheckRail({ steps }: { steps: readonly RailStep[] }) {
  return (
    <ol data-testid="mission-check-rail" aria-label="Mission checkpoints" className="grid grid-cols-3 gap-2.5">
      {steps.map(s => (
        <li key={s.key} data-step={s.key} data-state={s.state} aria-current={s.state === 'now' || s.state === 'held' ? 'step' : undefined} className="min-w-0">
          <span aria-hidden="true" data-testid="mission-check-rail-bar" className={`mb-2 block rounded-full ${s.state === 'now' || s.state === 'held' ? 'h-[6px]' : 'mt-[3px] h-[3px]'} ${RAIL_BAR[s.state]}`} />
          <span className={`block text-title font-medium ${s.state === 'todo' ? 'text-text-muted' : 'text-text-primary'}`}>{s.label}</span>
          <span className="block font-mono text-meta leading-snug text-text-muted [overflow-wrap:anywhere]">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The selected outcome spec, one line under the rail (R-40): title, revision, status, link. */
export function OutcomeSpecLines({ lines }: { lines: readonly OutcomeSpecLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul data-testid="mission-outcome-spec" aria-label="Outcome spec" className="flex flex-col gap-1">
      {lines.map(l => (
        // One line at every width: the title truncates, the revision and status never wrap.
        <li key={l.specId} data-testid="mission-outcome-spec-line" className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap text-body">
          <span className="shrink-0 text-text-muted">Spec</span>
          <a href={l.href} title={l.title} className="min-w-0 truncate font-medium text-text-primary underline-offset-4 hover:underline">{l.title}</a>
          <span className="shrink-0 font-mono text-meta text-text-muted">{l.revision} · {l.status}</span>
        </li>
      ))}
    </ul>
  );
}

/** The folded strip once every build task is done (R-11). Never says delivered (R-12). */
export function BuildCompleteBar({ done, where, open, onToggle, children }: { done: number; where: string; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Card data-testid="build-complete-bar" padding="sm" className="flex flex-wrap items-center gap-x-4 gap-y-2 md:px-4">
        <span aria-hidden="true" className="flex gap-[3px]">
          {Array.from({ length: Math.min(done, 12) }, (_, i) => (
            <span key={i} className="state-cell inline-block h-3.5 w-2 rounded-[var(--radius-cell)]" data-tone="ok" data-pattern="solid" />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-title font-medium text-text-primary">Build complete</span>
          <span className="font-mono text-meta text-text-muted [overflow-wrap:anywhere]">{done} of {done} in {where}</span>
        </span>
        <button type="button" aria-expanded={open} data-testid="build-complete-toggle" onClick={onToggle} className="min-h-11 font-mono text-meta text-text-secondary underline-offset-4 hover:text-text-primary hover:underline md:min-h-0">
          {open ? 'Hide tasks' : 'Show tasks'}
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

const LIVE: ReadonlySet<CheckStatus> = new Set(['running', 'finding', 'owner', 'unable', 'stale']);

/** The checks that apply, one row each (R-16). */
export function ChecksCard({ rows, onOpenTask }: { rows: readonly CheckRow[]; onOpenTask?: (id: string) => void }) {
  const [skipping, setSkipping] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <SkipContext.Provider value={{ skipping, setSkipping }}>
    <section data-testid="mission-checks" aria-labelledby="mission-checks-title" className="flex flex-col gap-2">
      <h2 id="mission-checks-title" className="text-meta text-text-muted">Checks</h2>
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
              <span className="font-medium text-text-primary">{r.label}</span>
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
            {r.waivable && <CheckSkip.Form row={r.key} />}
            {(r.repairs.length > 0 || r.evidence.length > 0) && (
              <div className="col-start-2 mt-1 flex flex-col gap-2 md:col-[2/4]">
                {r.repairs.length > 0 && (
                  <ul data-testid="mission-check-repairs" aria-label="Fixes" className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border-l-2 border-status-error px-3 py-2 [background:var(--inset)]">
                    {r.repairs.map(f => (
                      <li key={f.id} className="flex min-w-0 items-center gap-2.5 text-body">
                        <span aria-hidden="true" className="state-cell inline-block h-3.5 w-3.5 shrink-0 rounded-[var(--radius-cell)]" data-tone={f.done ? 'ok' : 'act'} data-pattern={f.done ? 'solid' : 'hatch-bold'} />
                        {onOpenTask
                          ? <button type="button" onClick={() => onOpenTask(f.id)} className="min-h-11 min-w-0 text-left md:min-h-0 text-text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]">{f.title}</button>
                          : <span className="min-w-0 text-text-primary [overflow-wrap:anywhere]">{f.title}</span>}
                        <span className="ml-auto shrink-0 font-mono text-meta text-text-muted">{f.done ? 'landed' : 'fixing'}</span>
                      </li>
                    ))}
                  </ul>
                )}
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

// ── Skip (R-34) ──────────────────────────────────────────────────────────────

const SkipContext = createContext<{ skipping: string | null; setSkipping: (key: string | null) => void }>({ skipping: null, setSkipping: () => {} });

/**
 * Skip on a check a person may waive: one word beside the status, then one
 * reason field in place. It records the existing visual-audit waiver
 * (PATCH surfaceAuditWaiver); the row then reads waived, never passed.
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
    const id = useId();
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (!ctx || ctx.readonly || ctx.waiver || skipping !== row) return null;
    async function submit() {
      setSaving(true);
      setError(null);
      const out = await saveSurfaceAuditWaiver(ctx!.missionId, reason);
      setSaving(false);
      if (!out.ok) { setError(out.error); return; }
      setSkipping(null);
      router.refresh();
    }
    return (
      <form
        data-testid="mission-check-skip-form"
        className="col-start-2 mt-1 flex flex-col gap-2 md:col-[2/4]"
        onSubmit={e => { e.preventDefault(); void submit(); }}
      >
        <label htmlFor={id} className="text-meta text-text-secondary">Why skip it?</label>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            id={id}
            autoFocus
            value={reason}
            onChange={e => { setReason(e.target.value); if (error) setError(null); }}
            minLength={SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH}
            required
            aria-invalid={error ? true : undefined}
            data-testid="mission-check-skip-reason"
            placeholder="No screens changed for users"
            className="min-h-11 min-w-0 flex-1 bg-surface-1 px-2 text-body text-text-primary md:min-h-9"
          />
          <span className="flex gap-2">
            <button type="submit" disabled={saving} data-testid="mission-check-skip-confirm" className="btn btn-primary h-11 md:h-9">{saving ? 'Skipping…' : 'Skip review'}</button>
            <button type="button" disabled={saving} onClick={() => setSkipping(null)} className="btn btn-quiet h-11 md:h-9">Cancel</button>
          </span>
        </div>
        {error && <p role="alert" className="font-mono text-meta text-status-error [overflow-wrap:anywhere]">{error}</p>}
      </form>
    );
  },
};
