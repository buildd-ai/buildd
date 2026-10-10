'use client';

import Segmented from '@/components/ui/Segmented';

export type CriteriaGraderValue = 'auto' | 'api' | 'runner';

const OPTIONS: Array<{ value: CriteriaGraderValue; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'api', label: 'API key' },
    { value: 'runner', label: 'Runner' },
];

/** `gitConfig.criteriaGrader` as the control shows it. Missing (or anything unknown) means auto. */
export function normalizeCriteriaGrader(value: unknown): CriteriaGraderValue {
    return value === 'api' || value === 'runner' ? value : 'auto';
}

/**
 * Workspace default grader for prose goal criteria. Controlled: the value is
 * saved with the rest of GitConfigForm through POST /api/workspaces/[id]/config.
 */
export function CriteriaGraderControl({
    value,
    onChange,
}: {
    value: CriteriaGraderValue;
    onChange: (value: CriteriaGraderValue) => void;
}) {
    return (
        <div>
            <span className="block text-sm text-text-primary mb-1">
                Criteria grading
            </span>
            <Segmented<CriteriaGraderValue> label="Criteria grading" items={OPTIONS} value={value} onChange={onChange} />
            <p className="text-xs text-text-muted mt-1">
                Auto uses your API key if you set one. Otherwise a runner uses your team&apos;s subscription.
            </p>
        </div>
    );
}
