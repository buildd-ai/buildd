'use client';

/**
 * "Waive visual audit": a person's way to let a mission that changed UI
 * complete without a visual audit, from the mission page (task 16ccb1b3).
 *
 * It goes through the one existing path, PATCH /api/missions/[id] with
 * `surfaceAuditWaiver`, which records the reason, the actor and the time as
 * the mission's "Surface audit waived" note and refuses an in-task agent or a
 * task token. This component adds no rule of its own beyond the reason's
 * minimum length, which the route also enforces.
 *
 * Two places show it: the Settings sheet's Visual review card (`setting`) and
 * the drawer of a not-yet-started `[surface audit]` task (`tile`). On a
 * mission-branch mission the tile also says why the audit cannot run there.
 */
import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH } from '@buildd/core/surface-audit';
import Sheet from '@/components/ui/Sheet';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { ZonedTime } from '@/components/DisplayTimezone';

/** CI Visual QA cannot capture a mission branch until this lands. */
export const MISSION_BRANCH_CAPTURE_URL = 'https://github.com/buildd-ai/buildd/pull/3900';

export interface SurfaceAuditWaiverRecord {
  reason: string;
  /** Who set it, as the mission feed labels them. */
  actorLabel: string | null;
  /** ISO time it was recorded. */
  at: string;
}

export interface MissionSurfaceAuditWaiverProps {
  missionId: string;
  /** The latest person-set waiver, or null. */
  waiver: SurfaceAuditWaiverRecord | null;
  /** The mission runs on one integration branch (`branchStrategy: mission-branch`). */
  missionBranch: boolean;
  /** A closed mission: show a recorded waiver, offer nothing. */
  readonly?: boolean;
  variant?: 'setting' | 'tile';
}

const TRIGGER = 'inline-flex min-h-11 md:min-h-9 items-center border-2 border-border-strong px-3 font-mono text-meta font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50';

export default function MissionSurfaceAuditWaiver({
  missionId,
  waiver,
  missionBranch,
  readonly = false,
  variant = 'setting',
}: MissionSurfaceAuditWaiverProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SurfaceAuditWaiverRecord | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const hintId = useId();

  const record = saved ?? waiver;

  async function submit() {
    const text = reason.trim();
    if (text.length < SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH) {
      setError(`Write at least ${SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surfaceAuditWaiver: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof body?.error === 'string' && body.error ? body.error : 'Could not save the waiver. Try again.');
        return;
      }
      setSaved({ reason: text, actorLabel: null, at: new Date().toISOString() });
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not save the waiver. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const note = variant === 'tile' && missionBranch && !record ? (
    <p data-testid="surface-audit-mission-branch-note" className="font-mono text-meta leading-normal text-text-secondary [overflow-wrap:anywhere]">
      CI Visual QA can&apos;t capture a mission branch, so this audit can&apos;t run here.{' '}
      <a href={MISSION_BRANCH_CAPTURE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
        Tracking PR #3900
      </a>
    </p>
  ) : null;

  return (
    <div data-testid="surface-audit-waiver" data-variant={variant} className="flex min-w-0 flex-col gap-2">
      {note}
      {record ? (
        <WaiverRecord record={record} />
      ) : !readonly ? (
        <div>
          <button
            ref={triggerRef}
            type="button"
            data-action="waive-visual-audit"
            className={TRIGGER}
            onClick={() => { setError(null); setOpen(true); }}
          >
            Waive visual audit
          </button>
        </div>
      ) : null}

      <Sheet
        open={open}
        onClose={() => { if (!saving) setOpen(false); }}
        title="Waive visual audit"
        testId="surface-audit-waiver-sheet"
        trapFocus
        returnFocusRef={triggerRef}
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={e => { e.preventDefault(); void submit(); }}
        >
          <p className="text-body leading-normal text-text-secondary">
            The mission can complete without a visual audit. The reason is kept on the mission with your name.
          </p>
          <label htmlFor={reasonId} className="font-mono text-meta font-medium text-text-primary">
            Reason
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={e => { setReason(e.target.value); if (error) setError(null); }}
            rows={3}
            required
            aria-describedby={hintId}
            aria-invalid={error ? true : undefined}
            data-testid="surface-audit-waiver-reason"
            className="block w-full min-w-0 bg-surface-1 px-2 py-1.5 text-body text-text-primary"
            placeholder="Why no visual audit is needed"
          />
          <p id={hintId} className="font-mono text-meta text-text-muted">
            At least {SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH} characters.
          </p>
          {error && <p role="alert" className="font-mono text-meta text-status-error [overflow-wrap:anywhere]">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryAction type="submit" pending={saving} data-testid="confirm-waive-visual-audit">
              Waive audit
            </PrimaryAction>
            <button type="button" className="btn btn-quiet h-11 md:h-10" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

function WaiverRecord({ record }: { record: SurfaceAuditWaiverRecord }) {
  return (
    <div data-testid="surface-audit-waiver-record" className="min-w-0 border border-border-default bg-surface-2 p-3">
      <p className="font-mono text-meta font-semibold text-text-primary">Visual audit waived</p>
      <p className="mt-1 text-body leading-normal text-text-secondary [overflow-wrap:anywhere]">{record.reason}</p>
      <p className="mt-1 font-mono text-meta text-text-muted [overflow-wrap:anywhere]">
        {record.actorLabel ? <>{record.actorLabel} · </> : null}
        <ZonedTime value={record.at} format="datetime" />
      </p>
    </div>
  );
}

// ── Mission context for the audit task's drawer ─────────────────────────────

const Ctx = createContext<Omit<MissionSurfaceAuditWaiverProps, 'variant'> | null>(null);

/** Lets the Board's audit drawer offer the waiver without threading props through the layouts. */
export function MissionSurfaceAuditWaiverProvider({
  children,
  ...value
}: Omit<MissionSurfaceAuditWaiverProps, 'variant'> & { children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The waiver, as the audit task's drawer shows it; nothing outside a mission page's provider. */
export function SurfaceAuditWaiverTile({ missionId }: { missionId: string | null | undefined }) {
  const ctx = useContext(Ctx);
  if (!ctx || !missionId || ctx.missionId !== missionId) return null;
  return <MissionSurfaceAuditWaiver {...ctx} variant="tile" />;
}
