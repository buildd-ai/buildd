'use client';

export type WorkflowType = 'single' | 'fan-out' | 'sequential' | 'release';

const WORKFLOW_OPTIONS: { value: WorkflowType; label: string; description: string }[] = [
  { value: 'single', label: 'Single agent', description: 'One agent works the task end-to-end' },
  { value: 'fan-out', label: 'Fan-out / merge', description: 'Spawn parallel sub-tasks, then merge results' },
  { value: 'sequential', label: 'Sequential pipeline', description: 'Chain tasks one after another' },
  { value: 'release', label: 'Release pipeline', description: 'Build, test, and release in sequence' },
];

interface WorkflowSelectorProps {
  value: WorkflowType;
  onChange: (value: WorkflowType) => void;
}

export function WorkflowSelector({ value, onChange }: WorkflowSelectorProps) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">Workflow</label>
      <div className="grid grid-cols-2 gap-2">
        {WORKFLOW_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-2 text-left text-sm rounded-lg border transition-colors ${
              value === opt.value
                ? 'border-primary bg-primary/10 text-text-primary'
                : 'border-border-default bg-surface-2 text-text-secondary hover:bg-surface-3'
            }`}
          >
            <span className="font-medium block">{opt.label}</span>
            <span className="text-xs text-text-muted">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
