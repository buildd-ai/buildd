import { existsSync } from 'fs';
import { join } from 'path';

export interface WorkspaceResolver {
  resolve(workspace: { id: string; name: string; repo?: string | null }): string | null;
}

export function createWorkspaceResolver(projectsRoot: string): WorkspaceResolver {
  return {
    resolve(workspace) {
      // Try workspace name directly
      const byName = join(projectsRoot, workspace.name);
      if (existsSync(byName)) {
        return byName;
      }

      // Try extracting repo name from URL
      if (workspace.repo) {
        const repoName = workspace.repo.split('/').pop()?.replace('.git', '');
        if (repoName) {
          const byRepo = join(projectsRoot, repoName);
          if (existsSync(byRepo)) {
            return byRepo;
          }
        }
      }

      // Try lowercase
      const byLower = join(projectsRoot, workspace.name.toLowerCase());
      if (existsSync(byLower)) {
        return byLower;
      }

      // Try kebab-case
      const kebab = workspace.name.toLowerCase().replace(/\s+/g, '-');
      const byKebab = join(projectsRoot, kebab);
      if (existsSync(byKebab)) {
        return byKebab;
      }

      console.warn(`Could not resolve workspace: ${workspace.name}`);
      return null;
    }
  };
}
