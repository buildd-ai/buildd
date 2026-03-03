'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Recipe } from './RecipeList';

interface Props {
  workspaceId: string;
  recipe: Recipe;
  onClose: () => void;
}

export function RunRecipeModal({ workspaceId, recipe, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTasks, setCreatedTasks] = useState<string[] | null>(null);

  const variableKeys = recipe.variables ? Object.keys(recipe.variables) : [];
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    () => Object.fromEntries(variableKeys.map(k => [k, recipe.variables![k].default || '']))
  );

  async function handleRun() {
    setRunning(true);
    setError(null);

    const body: { variables?: Record<string, string> } = {};
    if (variableKeys.length > 0) {
      body.variables = variableValues;
    }

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/recipes/${recipe.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to run recipe');
      }

      const data = await res.json();
      setCreatedTasks(data.tasks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run recipe');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface-2 border border-border-default rounded-lg shadow-lg max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Run Recipe</h2>
              <p className="text-sm text-text-muted mt-0.5">{recipe.name}</p>
            </div>
            <button onClick={onClose} className="p-1 text-text-muted hover:text-text-secondary">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Steps preview */}
          <div className="mb-6">
            <h3 className="text-sm font-medium mb-2">Steps ({recipe.steps.length})</h3>
            <div className="space-y-1">
              {recipe.steps.map((step, i) => (
                <div key={step.ref} className="flex items-center gap-2 text-sm">
                  <span className="text-text-muted w-5 text-right shrink-0">{i + 1}.</span>
                  <span className="text-text-secondary">{step.title}</span>
                  {step.dependsOn && step.dependsOn.length > 0 && (
                    <span className="text-xs text-text-muted">
                      (after {step.dependsOn.join(', ')})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Success state */}
          {createdTasks && (
            <div className="mb-4 p-4 bg-status-success/10 border border-status-success/20 rounded-md">
              <p className="text-sm font-medium text-status-success mb-2">
                Recipe started — {createdTasks.length} task{createdTasks.length !== 1 ? 's' : ''} created
              </p>
              <div className="space-y-1">
                {createdTasks.map((taskId) => (
                  <Link
                    key={taskId}
                    href={`/app/tasks/${taskId}`}
                    className="block text-sm text-primary hover:underline"
                  >
                    View task {taskId.slice(0, 8)}...
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Variable inputs */}
          {!createdTasks && variableKeys.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-medium mb-2">Variables</h3>
              <div className="space-y-3">
                {variableKeys.map((key) => {
                  const variable = recipe.variables![key];
                  return (
                    <div key={key}>
                      <label className="block text-xs font-medium mb-1 text-text-secondary">
                        <code className="font-mono">{key}</code>
                        {variable.description && (
                          <span className="font-normal text-text-muted ml-2">{variable.description}</span>
                        )}
                      </label>
                      <input
                        type={variable.type === 'number' ? 'number' : 'text'}
                        value={variableValues[key]}
                        onChange={(e) => setVariableValues(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full px-3 py-1.5 text-sm border border-border-default rounded-md bg-surface-1"
                        placeholder={`Enter ${key}...`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-status-error mb-4">{error}</p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm border border-border-default rounded-md hover:bg-surface-3"
            >
              {createdTasks ? 'Close' : 'Cancel'}
            </button>
            {!createdTasks && (
              <button
                type="button"
                onClick={handleRun}
                disabled={running}
                className="px-4 py-2 text-sm bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
              >
                {running ? 'Running...' : 'Run Recipe'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
