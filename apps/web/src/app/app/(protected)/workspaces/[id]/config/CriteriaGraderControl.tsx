'use client';

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
            <span id="criteria-grader-label" className="block text-sm font-medium mb-1">
                Criteria grading
            </span>
            <div
                role="radiogroup"
                aria-labelledby="criteria-grader-label"
                className="inline-flex border-2 border-border-strong"
            >
                {OPTIONS.map((opt, i) => {
                    const selected = opt.value === value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => onChange(opt.value)}
                            className={`min-h-11 px-4 font-mono text-[13px] font-medium transition-colors ${
                                i > 0 ? 'border-l-2 border-border-strong' : ''
                            } ${
                                selected
                                    ? 'bg-primary text-white'
                                    : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                            }`}
                        >{opt.label}</button>
                    );
                })}
            </div>
            <p className="text-xs text-text-muted mt-1">
                Auto uses your API key when one is set, otherwise a runner on your team&apos;s seat.
            </p>
        </div>
    );
}
