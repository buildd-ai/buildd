'use client';

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { MODEL_OPTIONS } from '@/lib/config-helpers';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface MissionConfigProps {
  missionId: string;
  workspaceId: string | null;
  model: string | null;
  workspaces: WorkspaceOption[];
  maxConcurrentTasks: number | null;
  activeTasks: number;
  costBudgetUsd: string | null;
}

export default function MissionConfig({
  missionId,
  workspaceId,
  model: initialModel,
  workspaces,
  maxConcurrentTasks: initialMaxConcurrent,
  activeTasks,
  costBudgetUsd: initialCostBudgetUsd,
}: MissionConfigProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Model state
  const [model, setModel] = useState(initialModel || '');

  // Workspace state
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || '');

  // Max concurrent tasks state
  const [maxConcurrent, setMaxConcurrent] = useState<string>(initialMaxConcurrent != null ? String(initialMaxConcurrent) : '');

  // Cost budget state
  const [costBudget, setCostBudget] = useState<string>(initialCostBudgetUsd != null ? String(parseFloat(initialCostBudgetUsd)) : '');

  const disabled = saving !== null || isPending;

  const patchMission = useCallback(async (body: Record<string, unknown>, field: string) => {
    setSaving(field);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        startTransition(() => router.refresh());
      }
    } finally {
      setSaving(null);
    }
  }, [missionId, router]);

  function handleModelChange(value: string) {
    setModel(value);
    patchMission({ model: value || null }, 'model');
  }

  function handleWorkspaceChange(value: string) {
    setSelectedWorkspaceId(value);
    patchMission({ workspaceId: value || null }, 'workspace');
  }

  function handleMaxConcurrentBlur() {
    const trimmed = maxConcurrent.trim();
    const parsed = trimmed ? parseInt(trimmed, 10) : null;
    if (trimmed && (isNaN(parsed!) || parsed! < 1)) return;
    if (parsed === initialMaxConcurrent) return;
    patchMission({ maxConcurrentTasks: parsed }, 'maxConcurrentTasks');
  }

  function handleCostBudgetBlur() {
    const trimmed = costBudget.trim();
    const parsed = trimmed ? parseFloat(trimmed) : null;
    if (trimmed && (isNaN(parsed!) || parsed! <= 0)) return;
    const initial = initialCostBudgetUsd != null ? parseFloat(initialCostBudgetUsd) : null;
    if (parsed === initial) return;
    patchMission({ costBudgetUsd: parsed }, 'costBudgetUsd');
  }

  const workspaceOptions = [
    { value: '', label: 'No workspace' },
    ...workspaces.map(ws => ({ value: ws.id, label: ws.name })),
  ];

  // Summarize what's configured for the collapsed view
  const configSummary = [
    model && MODEL_OPTIONS.find(m => m.value === model)?.label,
    initialMaxConcurrent != null && `Max ${initialMaxConcurrent} concurrent`,
    initialCostBudgetUsd != null && `Budget $${parseFloat(initialCostBudgetUsd).toFixed(2)}`,
  ].filter(Boolean);

  return (
    <div className="card p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <h2 className="section-label">Configuration</h2>
          {!expanded && configSummary.length > 0 && (
            <span className="text-[11px] text-text-muted">{configSummary.join(' · ')}</span>
          )}
        </div>
        <svg className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Workspace */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Workspace</label>
            <div className="max-w-xs">
              <Select
                value={selectedWorkspaceId}
                onChange={handleWorkspaceChange}
                options={workspaceOptions}
                placeholder="No workspace"
                size="sm"
                disabled={disabled}
              />
            </div>
            {selectedWorkspaceId !== (workspaceId || '') && (
              <p className="text-[11px] text-status-warning mt-1">
                Changing workspace will update where scheduled tasks run.
              </p>
            )}
          </div>

          {/* Max Concurrent Tasks */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Max concurrent tasks</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={maxConcurrent}
                onChange={e => setMaxConcurrent(e.target.value)}
                onBlur={handleMaxConcurrentBlur}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="No limit"
                disabled={disabled}
                className="w-24 px-2 py-1 bg-surface-3 border border-card-border rounded-lg text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 tabular-nums disabled:opacity-50"
              />
              {initialMaxConcurrent != null && (
                <>
                  <span className="text-[11px] text-text-muted tabular-nums">
                    {activeTasks} / {initialMaxConcurrent} active
                  </span>
                  <button
                    type="button"
                    onClick={() => { setMaxConcurrent(''); patchMission({ maxConcurrentTasks: null }, 'maxConcurrentTasks'); }}
                    disabled={disabled}
                    className="text-[11px] text-status-error hover:text-status-error/80 disabled:opacity-50"
                  >
                    Remove limit
                  </button>
                </>
              )}
            </div>
            <p className="text-[11px] text-text-muted mt-1">
              Cap how many tasks this mission can run at once.
            </p>
          </div>

          {/* Cost budget */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Cost budget (USD)</label>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-muted">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={costBudget}
                onChange={e => setCostBudget(e.target.value)}
                onBlur={handleCostBudgetBlur}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="No limit"
                disabled={disabled}
                className="w-28 px-2 py-1 bg-surface-3 border border-card-border rounded-lg text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 tabular-nums disabled:opacity-50"
              />
              {initialCostBudgetUsd != null && (
                <button
                  type="button"
                  onClick={() => { setCostBudget(''); patchMission({ costBudgetUsd: null }, 'costBudgetUsd'); }}
                  disabled={disabled}
                  className="text-[11px] text-status-error hover:text-status-error/80 disabled:opacity-50"
                >
                  Remove limit
                </button>
              )}
            </div>
            <p className="text-[11px] text-text-muted mt-1">
              Mission pauses when spend reaches this limit. Empty = uncapped.
            </p>
          </div>

          {/* Model */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Model</label>
            <div className="max-w-xs">
              <Select
                value={model}
                onChange={handleModelChange}
                options={MODEL_OPTIONS}
                placeholder="Default"
                size="sm"
                disabled={disabled}
              />
            </div>
          </div>

          {saving && (
            <p className="text-[11px] text-text-muted animate-pulse">Saving {saving}...</p>
          )}
        </div>
      )}
    </div>
  );
}
