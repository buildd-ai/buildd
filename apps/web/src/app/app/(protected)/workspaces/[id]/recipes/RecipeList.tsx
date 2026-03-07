'use client';

import { useState } from 'react';
import { RunRecipeModal } from './RunRecipeModal';

export interface RecipeStep {
  ref: string;
  title: string;
  description?: string;
  mode?: string;
  dependsOn?: string[];
  requiredCapabilities?: string[];
  outputRequirement?: string;
  priority?: number;
}

export interface RecipeVariable {
  type: string;
  description?: string;
  default?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  steps: RecipeStep[];
  variables?: Record<string, RecipeVariable> | null;
  createdAt: string;
}

const CATEGORY_STYLES: Record<string, string> = {
  content: 'bg-cat-feature/10 text-cat-feature',
  research: 'bg-cat-refactor/10 text-cat-refactor',
  code: 'bg-cat-docs/10 text-cat-docs',
  ops: 'bg-cat-infra/10 text-cat-infra',
  custom: 'bg-surface-3 text-text-secondary',
};

interface Props {
  workspaceId: string;
  initialRecipes: Recipe[];
}

export function RecipeList({ workspaceId, initialRecipes }: Props) {
  const [recipes, setRecipes] = useState(initialRecipes);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [runRecipe, setRunRecipe] = useState<Recipe | null>(null);

  async function deleteRecipe(id: string) {
    if (!confirm('Delete this recipe? This cannot be undone.')) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/recipes/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setRecipes((prev) => prev.filter((r) => r.id !== id));
      }
    } catch {
      // Silent failure
    } finally {
      setDeleting(null);
    }
  }

  if (recipes.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted">
        <p className="text-lg mb-2">No recipes yet</p>
        <p className="text-sm">Create a recipe to define reusable multi-step workflows.</p>
      </div>
    );
  }

  return (
    <>
      <div className="border border-border-default rounded-lg divide-y divide-border-default">
        {recipes.map((recipe) => (
          <div key={recipe.id} className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium truncate">{recipe.name}</h3>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${CATEGORY_STYLES[recipe.category] || CATEGORY_STYLES.custom}`}>
                    {recipe.category}
                  </span>
                </div>
                {recipe.description && (
                  <p className="text-sm text-text-muted mt-1 line-clamp-2">{recipe.description}</p>
                )}
                <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                  <span>{recipe.steps.length} step{recipe.steps.length !== 1 ? 's' : ''}</span>
                  {recipe.variables && Object.keys(recipe.variables).length > 0 && (
                    <span>{Object.keys(recipe.variables).length} variable{Object.keys(recipe.variables).length !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 ml-4">
                <button
                  onClick={() => setRunRecipe(recipe)}
                  className="px-3 py-1.5 text-sm bg-primary text-white hover:bg-primary-hover rounded-md"
                >
                  Run
                </button>
                <button
                  onClick={() => deleteRecipe(recipe.id)}
                  disabled={deleting === recipe.id}
                  className="p-1.5 text-text-muted hover:text-status-error"
                  title="Delete"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {runRecipe && (
        <RunRecipeModal
          workspaceId={workspaceId}
          recipe={runRecipe}
          onClose={() => setRunRecipe(null)}
        />
      )}
    </>
  );
}
