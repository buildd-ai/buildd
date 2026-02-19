'use client';

import { useState, useEffect } from 'react';
import MarkdownContent from '@/components/MarkdownContent';

interface PlanReviewPanelProps {
  workerId: string;
  isAwaitingApproval: boolean;
}

export default function PlanReviewPanel({ workerId, isAwaitingApproval }: PlanReviewPanelProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [collapsed, setCollapsed] = useState(!isAwaitingApproval);

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

  // Expand when approval is needed
  useEffect(() => {
    if (isAwaitingApproval) setCollapsed(false);
  }, [isAwaitingApproval]);

  async function handleApprove(mode: 'bypass' | 'review') {
    setActionLoading(true);
    setActionResult(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve plan');
      }
      const modeLabel = mode === 'bypass' ? 'bypass permissions' : 'with review';
      setActionResult({ type: 'success', message: `Plan approved (${modeLabel}) — worker will implement` });
      setCollapsed(true);
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
      <div className="mb-4 bg-surface-2 rounded-[10px] border border-border-default p-6">
        <p className="text-sm text-text-secondary">Loading plan...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-4 border border-status-error/30 bg-status-error/5 rounded-[10px] p-4">
        <p className="text-sm text-status-error">{error}</p>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mb-4 bg-surface-2 rounded-[10px] border border-border-default p-6">
        <p className="text-sm text-text-secondary">Awaiting plan submission...</p>
      </div>
    );
  }

  const statusBadge = isAwaitingApproval
    ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
        </span>
        <span className="font-mono text-[10px] font-medium text-primary uppercase tracking-[2.5px]">Awaiting Review</span>
      </span>
    )
    : (
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" className="text-status-success">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span className="font-mono text-[10px] font-medium text-status-success uppercase tracking-[2.5px]">Approved</span>
      </span>
    );

  // Collapsed state
  if (collapsed) {
    return (
      <div className="mb-4 bg-surface-2 rounded-[10px] border border-border-default overflow-hidden">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-3/50 transition-colors text-left cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[2.5px] text-text-muted">Implementation Plan</span>
            {statusBadge}
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="text-text-muted">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 bg-surface-2 rounded-[10px] border border-border-default overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-surface-3/50 transition-colors"
        onClick={() => !isAwaitingApproval && setCollapsed(true)}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[2.5px] text-text-muted">Implementation Plan</span>
          {statusBadge}
        </div>
        {!isAwaitingApproval && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="text-text-muted rotate-180">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        )}
      </div>

      {/* Plan body */}
      <div className="px-6 pb-6 max-h-[60vh] overflow-y-auto">
        <MarkdownContent content={plan} />
      </div>

      {/* Action result */}
      {actionResult && (
        <div className={`mx-6 mb-4 text-sm ${actionResult.type === 'success' ? 'text-status-success' : 'text-status-error'}`}>
          {actionResult.message}
        </div>
      )}

      {/* Action footer */}
      {isAwaitingApproval && !actionResult?.type && (
        <div className="border-t border-border-default bg-surface-3/50 px-6 py-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleApprove('bypass')}
              disabled={actionLoading}
              className="px-4 py-2.5 text-sm bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {actionLoading ? 'Processing...' : 'Implement (bypass)'}
            </button>
            <button
              onClick={() => handleApprove('review')}
              disabled={actionLoading}
              className="px-4 py-2.5 text-sm bg-surface-4 text-text-primary border border-border-default rounded-lg hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {actionLoading ? 'Processing...' : 'Implement (review)'}
            </button>
            <button
              onClick={() => setShowFeedback(!showFeedback)}
              disabled={actionLoading}
              className="px-4 py-2.5 text-sm border border-status-warning/30 text-status-warning rounded-lg hover:bg-status-warning/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Request Changes
            </button>
          </div>

          {showFeedback && (
            <div className="mt-3">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Describe what changes you'd like to the plan..."
                className="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary min-h-[80px]"
                rows={3}
                disabled={actionLoading}
              />
              <button
                onClick={handleRevise}
                disabled={actionLoading || !feedback.trim()}
                className="mt-2 px-4 py-2 text-sm bg-status-warning text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {actionLoading ? 'Sending...' : 'Send Feedback'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
