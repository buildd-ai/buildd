'use client';

import { useState, useMemo } from 'react';
import { parsePlanSteps, matchMilestoneToStep, type PlanStep } from './plan-steps';

type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: string; label: string; ts: number }
  | { type: 'action'; label: string; ts: number };

interface PlanStepTrackerProps {
  planMarkdown: string;
  milestones: Milestone[];
  currentAction?: string | null;
}

export default function PlanStepTracker({ planMarkdown, milestones, currentAction }: PlanStepTrackerProps) {
  const [collapsed, setCollapsed] = useState(false);

  const steps = useMemo(() => parsePlanSteps(planMarkdown), [planMarkdown]);

  // Determine active step by matching phase milestones against step text
  const activeStepIndex = useMemo(() => {
    if (steps.length === 0) return -1;

    // Walk milestones newest-first to find the latest phase match
    const phaseMilestones = [...milestones]
      .filter((m): m is Extract<Milestone, { type: 'phase' | 'status' }> =>
        m.type === 'phase' || m.type === 'status'
      )
      .sort((a, b) => b.ts - a.ts);

    for (const m of phaseMilestones) {
      const idx = matchMilestoneToStep(m.label, steps);
      if (idx >= 0) return idx;
    }
    return -1;
  }, [steps, milestones]);

  if (steps.length === 0) return null;

  const completedCount = activeStepIndex >= 0 ? activeStepIndex : 0;
  const totalSteps = steps.length;
  const summaryText = activeStepIndex >= 0
    ? `Step ${activeStepIndex + 1}/${totalSteps}`
    : `${totalSteps} steps`;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-3/50 rounded-lg hover:bg-surface-3 transition-colors text-left cursor-pointer mb-4"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] font-medium text-text-muted uppercase tracking-[2px]">Plan Progress</span>
          <span className="font-mono text-xs text-primary">{summaryText}</span>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" className="text-text-muted">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] font-medium text-text-muted uppercase tracking-[2px]">Plan Progress</span>
          <span className="font-mono text-xs text-primary">{summaryText}</span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="text-text-muted hover:text-text-primary p-1"
          title="Collapse"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
      </div>

      <div className="space-y-0.5">
        {steps.map((step, i) => {
          const status = getStepStatus(i, activeStepIndex);
          return (
            <StepRow
              key={step.id}
              step={step}
              status={status}
              currentAction={status === 'active' ? currentAction : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function getStepStatus(index: number, activeIndex: number): 'completed' | 'active' | 'pending' {
  if (activeIndex < 0) return 'pending';
  if (index < activeIndex) return 'completed';
  if (index === activeIndex) return 'active';
  return 'pending';
}

function StepRow({
  step,
  status,
  currentAction,
}: {
  step: PlanStep;
  status: 'completed' | 'active' | 'pending';
  currentAction?: string | null;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 py-1.5 ${step.depth > 0 ? 'ml-5' : ''}`}
    >
      {/* Status indicator */}
      <span className="mt-1 flex-shrink-0">
        {status === 'completed' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="12" height="12" className="text-status-success">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ) : status === 'active' ? (
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-surface-3 mt-[1px]" />
        )}
      </span>

      {/* Step text */}
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${
          status === 'completed' ? 'text-text-muted line-through' :
          status === 'active' ? 'text-text-primary font-medium' :
          'text-text-secondary'
        }`}>
          {step.text}
        </span>
        {status === 'active' && currentAction && (
          <p className="text-xs text-text-secondary mt-0.5 truncate">{currentAction}</p>
        )}
      </div>
    </div>
  );
}
