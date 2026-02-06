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
      <div className="mb-3 border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-4">
        <p className="text-sm text-gray-500">Loading plan...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-3 border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mb-3 border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-4">
        <p className="text-sm text-gray-500">Awaiting plan submission...</p>
      </div>
    );
  }

  return (
    <div className="mb-3 border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
        </span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300 uppercase">Plan Review</span>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-lg p-4 mb-3 max-h-96 overflow-y-auto border border-amber-100 dark:border-amber-900">
        <MarkdownContent content={plan} />
      </div>

      {actionResult && (
        <div className={`mb-3 text-sm ${actionResult.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {actionResult.message}
        </div>
      )}

      {!actionResult?.type && (
        <>
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading ? 'Processing...' : 'Approve Plan'}
            </button>
            <button
              onClick={() => setShowFeedback(!showFeedback)}
              disabled={actionLoading}
              className="px-4 py-2 text-sm border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                rows={3}
                disabled={actionLoading}
              />
              <button
                onClick={handleRevise}
                disabled={actionLoading || !feedback.trim()}
                className="mt-2 px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
