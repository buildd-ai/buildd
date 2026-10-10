'use client';

import { useState } from 'react';
import type { CopyReviewConfig, CopyReviewMode } from '@buildd/shared';
import Segmented from '@/components/ui/Segmented';

type Choice = 'off' | CopyReviewMode;

interface Props {
  workspaceId: string;
  initial: CopyReviewConfig | null;
  canEdit: boolean;
}

const OPTIONS: Array<{ value: Choice; label: string; describe: string }> = [
  { value: 'off', label: 'Off', describe: 'Reviews judge code only.' },
  { value: 'review', label: 'Comments', describe: 'The reviewer comments on new UI text. Merges are not held.' },
  { value: 'gate', label: 'Required', describe: 'New UI text that misses the voice guide goes back to the builder with a rewrite.' },
];

export default function CopyReviewSection({ workspaceId, initial, canEdit }: Props) {
  const [choice, setChoice] = useState<Choice>(initial?.mode ?? 'off');
  const [voiceGuide, setVoiceGuide] = useState(initial?.voiceGuide ?? 'docs/design/design-system.md');
  const [lintCommand, setLintCommand] = useState(initial?.lintCommand ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    const copyReview = choice === 'off'
      ? null
      : {
          voiceGuide: voiceGuide.trim(),
          mode: choice,
          ...(lintCommand.trim() ? { lintCommand: lintCommand.trim() } : {}),
          ...(initial?.paths ? { paths: initial.paths } : {}),
        };
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copyReview }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Not saved');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Not saved');
    } finally {
      setSaving(false);
    }
  }

  const chosen = OPTIONS.find((o) => o.value === choice) ?? OPTIONS[0];

  return (
    <form id="copy-review" onSubmit={handleSave} className="py-4 first:pt-0 last:pb-0 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Copy review</h3>
        <p className="text-xs text-text-secondary mt-0.5">Checks the UI text a PR adds against your voice guide.</p>
      </div>
      <Segmented<Choice>
        label="Copy review"
        items={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={choice}
        onChange={(v) => { if (canEdit) setChoice(v); }}
      />
      <p className="text-xs text-text-muted">{chosen.describe}</p>
      {choice !== 'off' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-text-secondary">
            Voice guide
            <input
              name="voiceGuide"
              value={voiceGuide}
              onChange={(e) => setVoiceGuide(e.target.value)}
              disabled={!canEdit}
              required
              className="mt-1 w-full border border-border-default bg-surface-1 px-3 py-2 font-mono text-base md:text-sm"
            />
          </label>
          <label className="block text-xs text-text-secondary">
            Lint command (optional)
            <input
              name="lintCommand"
              value={lintCommand}
              onChange={(e) => setLintCommand(e.target.value)}
              disabled={!canEdit}
              placeholder="bun run copy:check"
              className="mt-1 w-full border border-border-default bg-surface-1 px-3 py-2 font-mono text-base md:text-sm"
            />
          </label>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className="btn min-h-11">
            {saving ? 'Saving…' : 'Save copy review'}
          </button>
          {saved && <span className="text-status-success text-sm">Saved</span>}
          {saveError && <span className="text-status-error text-sm">{saveError}</span>}
        </div>
      )}
    </form>
  );
}
