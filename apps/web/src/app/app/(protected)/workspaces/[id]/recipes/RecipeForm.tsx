'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';

interface StepInput {
  ref: string;
  title: string;
  description: string;
  mode: string;
  dependsOn: string[];
  outputRequirement: string;
}

interface VariableInput {
  key: string;
  type: string;
  description: string;
}

const CATEGORY_OPTIONS = [
  { value: 'content', label: 'Content' },
  { value: 'research', label: 'Research' },
  { value: 'code', label: 'Code' },
  { value: 'ops', label: 'Ops' },
  { value: 'custom', label: 'Custom' },
];

const MODE_OPTIONS = [
  { value: 'execution', label: 'Execution' },
  { value: 'planning', label: 'Planning' },
];

const OUTPUT_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'none', label: 'No requirement' },
  { value: 'artifact_required', label: 'Artifact required' },
  { value: 'pr_required', label: 'PR required' },
  { value: 'auto', label: 'Auto' },
];

function generateRef(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30) || 'step';
}

interface Props {
  workspaceId: string;
}

export function RecipeForm({ workspaceId }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('custom');

  const [steps, setSteps] = useState<StepInput[]>([
    { ref: 'step_1', title: '', description: '', mode: 'execution', dependsOn: [], outputRequirement: '' },
  ]);

  const [variables, setVariables] = useState<VariableInput[]>([]);

  function addStep() {
    const num = steps.length + 1;
    setSteps([...steps, {
      ref: `step_${num}`,
      title: '',
      description: '',
      mode: 'execution',
      dependsOn: [],
      outputRequirement: '',
    }]);
  }

  function removeStep(index: number) {
    const removedRef = steps[index].ref;
    const updated = steps.filter((_, i) => i !== index);
    // Remove references to the deleted step from dependsOn
    setSteps(updated.map(s => ({
      ...s,
      dependsOn: s.dependsOn.filter(d => d !== removedRef),
    })));
  }

  function updateStep(index: number, field: keyof StepInput, value: string | string[]) {
    setSteps(steps.map((s, i) => {
      if (i !== index) return s;
      const updated = { ...s, [field]: value };
      // Auto-generate ref from title if title changed
      if (field === 'title' && typeof value === 'string') {
        updated.ref = generateRef(value) || `step_${index + 1}`;
      }
      return updated;
    }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const updated = [...steps];
    [updated[index], updated[target]] = [updated[target], updated[index]];
    setSteps(updated);
  }

  function toggleDependency(stepIndex: number, depRef: string) {
    setSteps(steps.map((s, i) => {
      if (i !== stepIndex) return s;
      const deps = s.dependsOn.includes(depRef)
        ? s.dependsOn.filter(d => d !== depRef)
        : [...s.dependsOn, depRef];
      return { ...s, dependsOn: deps };
    }));
  }

  function addVariable() {
    setVariables([...variables, { key: '', type: 'string', description: '' }]);
  }

  function removeVariable(index: number) {
    setVariables(variables.filter((_, i) => i !== index));
  }

  function updateVariable(index: number, field: keyof VariableInput, value: string) {
    setVariables(variables.map((v, i) => i === index ? { ...v, [field]: value } : v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const stepsPayload = steps.map(s => ({
      ref: s.ref,
      title: s.title,
      description: s.description || undefined,
      mode: s.mode || undefined,
      dependsOn: s.dependsOn.length > 0 ? s.dependsOn : undefined,
      outputRequirement: s.outputRequirement || undefined,
    }));

    const variablesPayload: Record<string, { type: string; description: string }> = {};
    for (const v of variables) {
      if (v.key.trim()) {
        variablesPayload[v.key.trim()] = { type: v.type, description: v.description };
      }
    }

    const body = {
      name,
      description: description || undefined,
      category,
      steps: stepsPayload,
      variables: Object.keys(variablesPayload).length > 0 ? variablesPayload : undefined,
    };

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create recipe');
      }

      router.push(`/app/workspaces/${workspaceId}/recipes`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create recipe');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic info */}
      <div className="border border-border-default rounded-lg p-6">
        <h3 className="font-semibold text-lg mb-4">New Recipe</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Recipe Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Content research pipeline"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Research a topic and produce a comprehensive report..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Category</label>
            <Select
              value={category}
              onChange={setCategory}
              options={CATEGORY_OPTIONS}
            />
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="border border-border-default rounded-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-lg">Steps</h3>
          <button
            type="button"
            onClick={addStep}
            className="text-sm text-primary hover:text-primary-hover"
          >
            + Add Step
          </button>
        </div>

        <div className="space-y-4">
          {steps.map((step, index) => (
            <div key={index} className="border border-border-default rounded-md p-4 bg-surface-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted font-mono">#{index + 1}</span>
                  <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded text-text-secondary">
                    {step.ref}
                  </code>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveStep(index, -1)}
                    disabled={index === 0}
                    className="p-1 text-text-muted hover:text-text-secondary disabled:opacity-30"
                    title="Move up"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(index, 1)}
                    disabled={index === steps.length - 1}
                    className="p-1 text-text-muted hover:text-text-secondary disabled:opacity-30"
                    title="Move down"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeStep(index)}
                      className="p-1 text-text-muted hover:text-status-error"
                      title="Remove step"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1 text-text-secondary">Title</label>
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => updateStep(index, 'title', e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-border-default rounded-md bg-surface-1"
                    placeholder="Research competitive landscape"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1 text-text-secondary">Description</label>
                  <textarea
                    value={step.description}
                    onChange={(e) => updateStep(index, 'description', e.target.value)}
                    rows={2}
                    className="w-full px-3 py-1.5 text-sm border border-border-default rounded-md bg-surface-1"
                    placeholder="Detailed instructions for this step..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-text-secondary">Mode</label>
                    <Select
                      value={step.mode}
                      onChange={(v) => updateStep(index, 'mode', v)}
                      options={MODE_OPTIONS}
                      size="sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-text-secondary">Output Requirement</label>
                    <Select
                      value={step.outputRequirement}
                      onChange={(v) => updateStep(index, 'outputRequirement', v)}
                      options={OUTPUT_OPTIONS}
                      size="sm"
                    />
                  </div>
                </div>

                {/* Dependencies */}
                {index > 0 && (
                  <div>
                    <label className="block text-xs font-medium mb-1 text-text-secondary">Depends On</label>
                    <div className="flex flex-wrap gap-2">
                      {steps.slice(0, index).map((otherStep) => (
                        <button
                          key={otherStep.ref}
                          type="button"
                          onClick={() => toggleDependency(index, otherStep.ref)}
                          className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                            step.dependsOn.includes(otherStep.ref)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border-default text-text-muted hover:border-text-secondary'
                          }`}
                        >
                          {otherStep.ref}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Variables */}
      <div className="border border-border-default rounded-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="font-semibold text-lg">Variables</h3>
            <p className="text-xs text-text-muted mt-0.5">Template variables that are filled in when running the recipe</p>
          </div>
          <button
            type="button"
            onClick={addVariable}
            className="text-sm text-primary hover:text-primary-hover"
          >
            + Add Variable
          </button>
        </div>

        {variables.length === 0 ? (
          <p className="text-sm text-text-muted">No variables defined. Add variables to make the recipe configurable.</p>
        ) : (
          <div className="space-y-3">
            {variables.map((variable, index) => (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-1">
                  <input
                    type="text"
                    value={variable.key}
                    onChange={(e) => updateVariable(index, 'key', e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-border-default rounded-md bg-surface-1 font-mono"
                    placeholder="variable_name"
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={variable.type}
                    onChange={(v) => updateVariable(index, 'type', v)}
                    options={[
                      { value: 'string', label: 'String' },
                      { value: 'number', label: 'Number' },
                      { value: 'boolean', label: 'Boolean' },
                    ]}
                    size="sm"
                  />
                </div>
                <div className="flex-1">
                  <input
                    type="text"
                    value={variable.description}
                    onChange={(e) => updateVariable(index, 'description', e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-border-default rounded-md bg-surface-1"
                    placeholder="Description"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeVariable(index)}
                  className="p-1.5 text-text-muted hover:text-status-error mt-0.5"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create Recipe'}
        </button>

        <a
          href={`/app/workspaces/${workspaceId}/recipes`}
          className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
        >
          Cancel
        </a>

        {error && (
          <span className="text-status-error text-sm">{error}</span>
        )}
      </div>
    </form>
  );
}
