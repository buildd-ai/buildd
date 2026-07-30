'use client';

import { useState } from 'react';

interface SubjectPolicy {
  mode?: 'observe' | 'propose' | 'enforce';
  autoCloseBuilddSupersededPrs?: boolean;
  priorWorkInjection?: boolean;
  conflictDeadDays?: number;
  proposalGraceHours?: number;
}

interface Props {
  workspaceId: string;
  initialPolicy: SubjectPolicy | null;
}

const DEFAULTS: Required<SubjectPolicy> = {
  mode: 'observe',
  autoCloseBuilddSupersededPrs: false,
  priorWorkInjection: true,
  conflictDeadDays: 7,
  proposalGraceHours: 24,
};

export default function SubjectPolicySection({ workspaceId, initialPolicy }: Props) {
  const merged = { ...DEFAULTS, ...initialPolicy };

  const [autoClose, setAutoClose] = useState(merged.autoCloseBuilddSupersededPrs);
  const [priorWork, setPriorWork] = useState(merged.priorWorkInjection);
  const [conflictDays, setConflictDays] = useState(String(merged.conflictDeadDays));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const days = parseInt(conflictDays, 10);
      const policy: SubjectPolicy = {
        ...merged,
        autoCloseBuilddSupersededPrs: autoClose,
        priorWorkInjection: priorWork,
        conflictDeadDays: Number.isFinite(days) && days >= 1 ? days : DEFAULTS.conflictDeadDays,
      };
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { subjectPolicy: policy } }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setMessage({ type: 'success', text: 'Subject policy saved.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to save subject policy.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 border border-border-subtle rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-1">Subject Anchor Policy</h2>
      <p className="text-sm text-text-muted mb-5">
        Controls how buildd tracks, deduplicates, and surfaces context for tasks anchored to a
        shared subject (a PR, a recurring error, or a mission). Safe defaults ship observe-only
        and can be tightened per workspace.
      </p>

      <div className="space-y-5">
        {/* Prior-work injection */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={priorWork}
            onChange={e => setPriorWork(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium">Prior-work injection</span>
            <span className="block text-xs text-text-muted mt-0.5">
              When a worker is claimed for a task anchored to an existing subject (PR or error),
              inject a summary of prior tasks, branches, and PR lifecycle into the agent&apos;s
              context. Enabled by default.
            </span>
          </span>
        </label>

        {/* Dead-PR shutdown */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={autoClose}
            onChange={e => setAutoClose(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium">
              Auto-close superseded buildd-authored PRs{' '}
              <span className="text-xs text-text-muted font-normal">(default OFF)</span>
            </span>
            <span className="block text-xs text-text-muted mt-0.5">
              When a successor PR merges, automatically close other open PRs authored by buildd
              for the same subject. Only buildd-authored PRs (verified via worker records) are
              eligible. Human-authored PRs are never auto-closed.
            </span>
          </span>
        </label>

        {/* Conflict-dead days */}
        {autoClose && (
          <div className="pl-7">
            <label className="block text-sm font-medium mb-1" htmlFor="conflict-dead-days">
              Conflict-dead grace period (days)
            </label>
            <input
              id="conflict-dead-days"
              type="number"
              min={1}
              max={90}
              className="w-24 border border-border-subtle rounded px-3 py-1.5 bg-surface-1 text-sm"
              value={conflictDays}
              onChange={e => setConflictDays(e.target.value)}
            />
            <p className="mt-1 text-xs text-text-muted">
              A PR in merge conflict with no green successor is closed automatically only after
              this many days. Defaults to 7.
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded bg-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>

        {message && (
          <span
            className={`text-sm ${message.type === 'success' ? 'text-status-success' : 'text-status-error'}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
