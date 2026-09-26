'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Spinner from '@/components/Spinner';
import MarkdownContent from '@/components/MarkdownContent';

/** Descriptions longer than this collapse to four lines behind "Show more". */
export const PLAN_STEP_PREVIEW_CHARS = 280;

/**
 * A plan step's description: rendered as markdown (planners write backticked
 * paths and bold), wrapped anywhere so a long path or URL cannot push the page
 * sideways on a phone, and clamped when long so the Approve / Reject actions
 * stay reachable.
 */
export function PlanStepDescription({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  // The char count only seeds the server render. Whether four lines actually
  // overflow depends on the width, so once mounted the clamped box is measured
  // (and re-measured on resize) and the toggle drops out where it would do
  // nothing, e.g. a 300-char step on a wide desktop column.
  const [overflows, setOverflows] = useState(content.length > PLAN_STEP_PREVIEW_CHARS);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, content]);
  const isLong = overflows;
  const clamped = !expanded;
  return (
    <div className="mt-1 min-w-0">
      <div ref={boxRef} className={clamped ? 'line-clamp-4 overflow-hidden' : undefined}>
        <MarkdownContent
          content={content}
          variant="compact"
          className="text-sm text-text-secondary [overflow-wrap:anywhere]"
        />
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="mt-1 min-h-11 md:min-h-0 font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted hover:text-text-primary cursor-pointer"
        >
          {expanded ? 'Show less ↑' : 'Show more ↓'}
        </button>
      )}
    </div>
  );
}

interface PlanStep {
  ref: string;
  title: string;
  description: string;
  dependsOn?: string[];
  requiredCapabilities?: string[];
  outputRequirement?: string;
  priority?: number;
}

interface PlanReviewPanelProps {
  taskId: string;
  mode: string;
  status: string;
  result: Record<string, unknown> | null;
}

/**
 * What a rejection actually did, read from the response rather than assumed.
 *
 * An ordinary plan rejection respawns a revised planning task and the reviewer
 * is sent to it. A doc-fix task's plan is an optional net-enhancement proposal:
 * rejecting it creates nothing — the docs-only PR shipped independently — and
 * the reason is retained on the discrepancy rows instead. Announcing a revised
 * task there would be untrue, and navigating to `taskId` would land on
 * /app/tasks/null.
 */
export function resolveRejectOutcome(data: {
  taskId?: string | null;
  proposalRejected?: boolean;
}): { text: string; navigateTo: string | null } {
  if (!data.taskId) {
    return {
      text:
        'Proposal rejected. The reason stays on its discrepancy, and the ' +
        'shipped documentation fix is unchanged.',
      navigateTo: null,
    };
  }
  return {
    text: 'Plan rejected. Opening the revised task…',
    navigateTo: data.taskId,
  };
}

export default function PlanReviewPanel({ taskId, mode, status, result }: PlanReviewPanelProps) {
  const router = useRouter();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Only render when conditions are met
  if (mode !== 'planning' || status !== 'completed') return null;

  const structuredOutput = result?.structuredOutput as Record<string, unknown> | undefined;
  const plan = structuredOutput?.plan as PlanStep[] | undefined;

  if (!plan || !Array.isArray(plan) || plan.length === 0) return null;

  const handleApprove = async () => {
    setApproving(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/approve-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 409) {
        // 409 covers two distinct states — already approved, and rejected.
        // Show what the server actually said so a reviewer who rejected this
        // plan is never told it was approved.
        const data = await res.json().catch(() => null);
        setMessage({ type: 'error', text: data?.error || 'Plan already approved' });
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve plan');
      }

      const data = await res.json();
      const count = data.tasks?.length || 0;
      setMessage({ type: 'success', text: `Plan approved, ${count} child task${count !== 1 ? 's' : ''} created` });
      router.refresh();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    if (!feedback.trim()) return;

    setRejecting(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/reject-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: feedback.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reject plan');
      }

      const data = await res.json();
      const outcome = resolveRejectOutcome(data);
      setMessage({ type: 'success', text: outcome.text });

      if (outcome.navigateTo) {
        // Navigate to the new revised task
        setTimeout(() => {
          router.push(`/app/tasks/${outcome.navigateTo}`);
        }, 1000);
      } else {
        // Nothing was created to navigate to — re-read this task so the panel
        // reflects the recorded rejection.
        router.refresh();
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div className="mb-8">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Plan Review
      </div>

      {/* Status message */}
      {message && (
        <div className={`mb-4 p-3 rounded-[8px] text-sm ${
          message.type === 'success'
            ? 'bg-status-success/10 text-status-success border border-status-success/20'
            : 'bg-status-error/10 text-status-error border border-status-error/20'
        }`}>
          {message.text}
        </div>
      )}

      {/* Plan steps */}
      <div className="space-y-3 mb-6">
        {plan.map((step, i) => (
          <div key={step.ref} className="p-4 bg-surface-2 border border-border-default rounded-[10px]">
            <div className="flex items-start gap-3">
              {/* Step number badge */}
              <span className="flex-shrink-0 w-7 h-7 rounded-[6px] flex items-center justify-center text-[12px] font-mono font-medium bg-primary/10 text-primary">
                {i + 1}
              </span>

              <div className="flex-1 min-w-0">
                {/* Header: ref badge + title */}
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <code className="px-1.5 py-0.5 text-[11px] font-mono bg-surface-3 text-text-muted rounded">
                    {step.ref}
                  </code>
                  <span className="text-sm font-medium text-text-primary min-w-0 [overflow-wrap:anywhere]">{step.title}</span>
                  {step.priority != null && step.priority > 0 && (
                    <span className="px-1.5 py-0.5 text-[11px] md:text-[10px] font-mono bg-status-warning/10 text-status-warning rounded">
                      P{step.priority}
                    </span>
                  )}
                </div>

                {/* Description */}
                {step.description && <PlanStepDescription content={step.description} />}

                {/* Metadata row */}
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {/* Dependencies */}
                  {step.dependsOn && step.dependsOn.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] md:text-[10px] font-mono text-text-muted uppercase tracking-[1px]">Depends on:</span>
                      {step.dependsOn.map((dep) => (
                        <code key={dep} className="px-1.5 py-0.5 text-[11px] md:text-[10px] font-mono bg-surface-3 text-text-secondary rounded">
                          {dep}
                        </code>
                      ))}
                    </div>
                  )}

                  {/* Capabilities */}
                  {step.requiredCapabilities && step.requiredCapabilities.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] md:text-[10px] font-mono text-text-muted uppercase tracking-[1px]">Requires:</span>
                      {step.requiredCapabilities.map((cap) => (
                        <span key={cap} className="px-1.5 py-0.5 text-[11px] md:text-[10px] font-medium bg-primary/10 text-primary rounded">
                          {cap}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reject feedback form */}
      {showRejectForm && (
        <div className="mb-4 p-4 bg-surface-2 border border-border-default rounded-[10px]">
          <label className="block text-sm text-text-secondary mb-2">
            What should change? (required)
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe the changes you want…"
            className="w-full px-3 py-2 text-sm bg-surface-1 border border-border-default rounded-[6px] text-text-primary placeholder:text-text-muted resize-y min-h-[80px] focus:outline-none focus:border-primary"
            rows={3}
            disabled={rejecting}
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => { setShowRejectForm(false); setFeedback(''); }}
              disabled={rejecting}
              className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-[6px]"
            >
              Cancel
            </button>
            <button
              onClick={handleReject}
              disabled={rejecting || !feedback.trim()}
              className="px-4 py-2 text-sm bg-status-error text-white rounded-[6px] hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {rejecting && <Spinner size="sm" className="text-white" aria-label="Rejecting" />}
              {rejecting ? 'Rejecting…' : 'Submit Rejection'}
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!message?.type || message.type === 'error' ? (
        <div className="flex gap-3">
          <button
            onClick={handleApprove}
            disabled={approving || rejecting}
            className="px-5 py-2.5 text-sm font-medium bg-status-success text-white rounded-[6px] hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {approving && <Spinner size="sm" className="text-white" aria-label="Approving" />}
            {approving ? 'Approving…' : 'Approve Plan'}
          </button>
          {!showRejectForm && (
            <button
              onClick={() => setShowRejectForm(true)}
              disabled={approving || rejecting}
              className="px-5 py-2.5 text-sm font-medium border border-border-default rounded-[6px] hover:bg-surface-3 disabled:opacity-50 text-text-secondary"
            >
              Reject Plan
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
