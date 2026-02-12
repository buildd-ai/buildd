'use client';

import { useState, useEffect } from 'react';
import MarkdownContent from '@/components/MarkdownContent';

interface PlanReviewPanelProps {
  workerId: string;
}

export default function PlanReviewPanel({ workerId }: PlanReviewPanelProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    async function fetchPlan() {
      try {
        const res = await fetch(`/api/workers/${workerId}/plan`);
        if (!res.ok) {
          if (res.status === 404) {
            setPlan(null);
            return;
          }
          throw new Error('Failed to fetch plan');
        }
        const data = await res.json();
        setPlan(data.plan?.content || null);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchPlan();
  }, [workerId]);

  async function handleApprove() {
    setActionLoading(true);
    setActionResult(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve plan');
      }
      setActionResult({ type: 'success', message: 'Plan approved - worker will continue with implementation' });
    } catch (err: any) {
      setActionResult({ type: 'error', message: err.message });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevise() {
    if (!feedback.trim()) return;
    setActionLoading(true);
    setActionResult(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/plan/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send revision request');
      }
      setActionResult({ type: 'success', message: 'Revision feedback sent to worker' });
      setFeedback('');
      setShowFeedback(false);
    } catch (err: any) {
      setActionResult({ type: 'error', message: err.message });
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-lg p-4">
        <p className="text-sm text-text-secondary">Loading plan...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-3 border border-status-error/30 bg-status-error/5 rounded-lg p-4">
        <p className="text-sm text-status-error">{error}</p>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-lg p-4">
        <p className="text-sm text-text-secondary">Awaiting plan submission...</p>
      </div>
    );
  }

  return (
    <div className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
        </span>
        <span className="text-xs font-medium text-status-warning uppercase">Plan Review</span>
      </div>

      <div className="bg-surface-1 rounded-md p-4 mb-3 max-h-[60vh] md:max-h-96 overflow-y-auto border border-status-warning/20">
        <MarkdownContent content={plan} />
      </div>

      {actionResult && (
        <div className={`mb-3 text-sm ${actionResult.type === 'success' ? 'text-status-success' : 'text-status-error'}`}>
          {actionResult.message}
        </div>
      )}

      {!actionResult?.type && (
        <>
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="flex-1 md:flex-none px-4 py-3 md:py-2 text-sm bg-status-success text-surface-1 rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading ? 'Processing...' : 'Approve Plan'}
            </button>
            <button
              onClick={() => setShowFeedback(!showFeedback)}
              disabled={actionLoading}
              className="flex-1 md:flex-none px-4 py-3 md:py-2 text-sm border border-status-warning/30 text-status-warning rounded-md hover:bg-status-warning/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Request Changes
            </button>
          </div>
          <button
            onClick={() => {
              setFeedback('Plan rejected');
              setShowFeedback(true);
            }}
            disabled={actionLoading}
            className="w-full py-3 md:py-2 text-sm text-status-error hover:bg-status-error/10 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reject Plan
          </button>

          {showFeedback && (
            <div className="mt-3">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Describe what changes you'd like to the plan..."
                className="w-full px-3 py-2 text-sm border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary min-h-[80px] md:min-h-0"
                rows={3}
                disabled={actionLoading}
              />
              <button
                onClick={handleRevise}
                disabled={actionLoading || !feedback.trim()}
                className="mt-2 px-4 py-3 md:py-2 text-sm bg-status-warning text-surface-1 rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionLoading ? 'Sending...' : 'Send Feedback'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
