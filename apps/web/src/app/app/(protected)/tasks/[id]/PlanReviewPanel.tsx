'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
        setMessage({ type: 'error', text: 'Plan already approved' });
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
      setMessage({ type: 'success', text: 'Plan rejected, revised task created. Redirecting...' });

      // Navigate to the new revised task
      setTimeout(() => {
        router.push(`/app/tasks/${data.taskId}`);
      }, 1000);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
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
                  <span className="text-sm font-medium text-text-primary">{step.title}</span>
                  {step.priority != null && step.priority > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono bg-status-warning/10 text-status-warning rounded">
                      P{step.priority}
                    </span>
                  )}
                </div>

                {/* Description */}
                {step.description && (
                  <p className="text-sm text-text-secondary mt-1">{step.description}</p>
                )}

                {/* Metadata row */}
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {/* Dependencies */}
                  {step.dependsOn && step.dependsOn.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-mono text-text-muted uppercase tracking-[1px]">Depends on:</span>
                      {step.dependsOn.map((dep) => (
                        <code key={dep} className="px-1.5 py-0.5 text-[10px] font-mono bg-surface-3 text-text-secondary rounded">
                          {dep}
                        </code>
                      ))}
                    </div>
                  )}

                  {/* Capabilities */}
                  {step.requiredCapabilities && step.requiredCapabilities.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-mono text-text-muted uppercase tracking-[1px]">Requires:</span>
                      {step.requiredCapabilities.map((cap) => (
                        <span key={cap} className="px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary rounded">
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
            Provide feedback for revision (required)
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what should be changed in the plan..."
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
              {rejecting && (
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {rejecting ? 'Rejecting...' : 'Submit Rejection'}
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
            {approving && (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {approving ? 'Approving...' : 'Approve Plan'}
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
