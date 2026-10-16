'use client';

import { useState } from 'react';
import type { VisualReviewPolicyMode } from '@buildd/shared';
import Segmented from '@/components/ui/Segmented';
import { ReadOnlyFacts } from './ReadOnlyFacts';

type Choice = 'inherit' | VisualReviewPolicyMode;

interface Props {
  workspaceId: string;
  /** This workspace's own override (`gitConfig.visualReview.policy`); null inherits. */
  override: VisualReviewPolicyMode | null;
  /** What it inherits when it has no override. */
  inherited: { mode: VisualReviewPolicyMode; origin: 'default' | 'team' };
  canEdit: boolean;
}

const MODES: Array<{ value: VisualReviewPolicyMode; label: string; describe: string }> = [
  { value: 'automatic', label: 'Automatic', describe: 'Reviews start on their own before a mission merges to trunk. A person can skip one with a recorded reason.' },
  { value: 'strict', label: 'Strict', describe: 'Every UI change is reviewed first. A review cannot be skipped, waived or turned off for a mission.' },
  { value: 'ask', label: 'Ask', describe: 'Buildd asks before finishing a mission that changed screens.' },
  { value: 'off', label: 'Off', describe: 'No review unless someone asks for one.' },
];
const label = (m: VisualReviewPolicyMode) => MODES.find((x) => x.value === m)!.label;
const describe = (m: VisualReviewPolicyMode) => MODES.find((x) => x.value === m)!.describe;

export default function VisualReviewPolicySection({ workspaceId, override, inherited, canEdit }: Props) {
  const [choice, setChoice] = useState<Choice>(override ?? 'inherit');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const effective = choice === 'inherit'
    ? { mode: inherited.mode, origin: inherited.origin === 'team' ? 'the team default' : 'the default' }
    : { mode: choice, origin: 'this workspace' };
  const effectiveLine = `${label(effective.mode)} · set by ${effective.origin}`;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visualReview: choice === 'inherit' ? null : { policy: choice } }),
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

  const header = (
    <div>
      <h3 className="text-sm font-medium text-text-primary">Visual review</h3>
      <p className="text-xs text-text-secondary mt-0.5">How missions that change screens are checked before they merge to trunk.</p>
    </div>
  );

  if (!canEdit) {
    return (
      <div id="visual-review" className="py-4 first:pt-0 last:pb-0 space-y-3">
        {header}
        <ReadOnlyFacts
          facts={[{ label: 'Visual review', value: effectiveLine, note: describe(effective.mode), testId: 'visual-review-effective' }]}
        />
      </div>
    );
  }

  return (
    <form id="visual-review" onSubmit={handleSave} className="py-4 first:pt-0 last:pb-0 space-y-3">
      {header}
      <Segmented<Choice>
        label="Visual review"
        items={[
          { value: 'inherit', label: 'Inherit' },
          ...MODES.map((m) => ({ value: m.value as Choice, label: m.label })),
        ]}
        value={choice}
        onChange={setChoice}
      />
      <p data-testid="visual-review-effective" className="text-sm text-text-primary">{effectiveLine}</p>
      <p className="text-xs text-text-muted">{describe(effective.mode)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className="btn min-h-11">
          {saving ? 'Saving…' : 'Save visual review'}
        </button>
        {saved && <span className="text-status-success text-sm">Saved</span>}
        {saveError && <span className="text-status-error text-sm">{saveError}</span>}
      </div>
    </form>
  );
}
