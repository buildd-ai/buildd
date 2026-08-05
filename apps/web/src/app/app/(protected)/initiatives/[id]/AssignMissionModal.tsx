'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export interface AssignableMission {
  id: string;
  title: string;
  workspaceName: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
}

interface Props {
  initiativeId: string;
  initiativeTitle: string;
  assignableMissions: AssignableMission[];
}

export default function AssignMissionModal({ initiativeId, initiativeTitle, assignableMissions }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Separate into unassigned and already-in-another-initiative
  const unassigned = assignableMissions.filter(m => !m.initiativeId);
  const inOther = assignableMissions.filter(m => !!m.initiativeId);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleOpen() {
    setSelected(new Set());
    setOpen(true);
  }

  function handleClose() {
    setOpen(false);
    setSelected(new Set());
  }

  // Close on Escape or backdrop click
  useEffect(() => {
    if (!open) return;
    function keyHandler(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', keyHandler);
    return () => document.removeEventListener('keydown', keyHandler);
  }, [open]);

  async function handleConfirm() {
    if (selected.size === 0) { handleClose(); return; }
    try {
      await Promise.all(
        [...selected].map(missionId =>
          fetch(`/api/missions/${missionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initiativeId }),
          })
        )
      );
      handleClose();
      startTransition(() => router.refresh());
    } catch {
      // non-fatal; page refresh will show current state
      handleClose();
      startTransition(() => router.refresh());
    }
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className="px-2.5 py-1 text-[11px] font-medium bg-surface-3 text-text-secondary border border-border-default rounded-sm hover:border-border-strong hover:text-text-primary transition-colors"
      >
        + Add mission
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div
            ref={dialogRef}
            className="bg-surface-2 border border-border-default rounded shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label={`Add missions to ${initiativeTitle}`}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-border-default flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                Add missions to {initiativeTitle.length > 30 ? `${initiativeTitle.slice(0, 30)}…` : initiativeTitle}
              </h2>
              <button
                onClick={handleClose}
                className="text-text-muted hover:text-text-secondary transition-colors"
                aria-label="Close"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
              {assignableMissions.length === 0 ? (
                <p className="text-sm text-text-muted text-center py-6">
                  All missions are already in initiatives.
                </p>
              ) : (
                <>
                  {unassigned.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">Unassigned</p>
                      <div className="space-y-1">
                        {unassigned.map(m => (
                          <label key={m.id} className="flex items-start gap-3 p-2.5 rounded hover:bg-surface-3 cursor-pointer transition-colors">
                            <input
                              type="checkbox"
                              checked={selected.has(m.id)}
                              onChange={() => toggle(m.id)}
                              className="mt-0.5 accent-primary shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-[13px] text-text-primary truncate">{m.title}</p>
                              {m.workspaceName && (
                                <p className="text-[11px] text-text-muted">{m.workspaceName}</p>
                              )}
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {inOther.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">In other initiatives</p>
                      <div className="space-y-1">
                        {inOther.map(m => (
                          <label key={m.id} className="flex items-start gap-3 p-2.5 rounded hover:bg-surface-3 cursor-pointer transition-colors">
                            <input
                              type="checkbox"
                              checked={selected.has(m.id)}
                              onChange={() => toggle(m.id)}
                              className="mt-0.5 accent-primary shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-[13px] text-text-primary truncate">{m.title}</p>
                              <p className="text-[11px] text-status-warning">
                                Moving from {m.initiativeTitle ?? 'another initiative'}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-border-default flex items-center justify-between gap-3">
              <span className="text-[12px] text-text-muted">
                {selected.size > 0 ? `${selected.size} selected` : 'Select missions to add'}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleClose}
                  className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={selected.size === 0 || isPending}
                  className="px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? 'Assigning…' : `Add ${selected.size > 0 ? selected.size : ''} mission${selected.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
