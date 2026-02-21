'use client';

type WorkflowType = 'single' | 'fan-out' | 'sequential' | 'release';

interface Props {
  value: WorkflowType;
  onChange: (value: WorkflowType) => void;
}

const workflows: { type: WorkflowType; label: string; diagram: string }[] = [
  { type: 'single', label: 'Single task', diagram: '' },
  { type: 'fan-out', label: 'Fan-out', diagram: '[Task] \u2192 [1] [2] [N] \u2192 [Merge]' },
  { type: 'sequential', label: 'Sequential', diagram: '[1] \u2192 [2] \u2192 [3]' },
  { type: 'release', label: 'Release', diagram: '[Test] [Lint] [Type] \u2192 [Release]' },
];

export function WorkflowSelector({ value, onChange }: Props) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">Workflow</label>
      <div className="flex items-center gap-1 p-1 bg-surface-3 rounded-lg w-fit flex-wrap">
        {workflows.map(w => (
          <button
            key={w.type}
            type="button"
            onClick={() => onChange(w.type)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap ${
              value === w.type
                ? 'bg-surface-1 text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>
      {value !== 'single' && (
        <div className="mt-2 px-3 py-2 bg-surface-2 border border-border-default rounded-md inline-block">
          <code className="text-xs text-text-secondary font-mono">
            {workflows.find(w => w.type === value)?.diagram}
          </code>
        </div>
      )}
    </div>
  );
}

export type { WorkflowType };
