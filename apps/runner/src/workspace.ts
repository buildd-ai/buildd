import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

export interface WorkspaceResolver {
  resolve(workspace: { id: string; name: string; repo?: string | null }): string | null;
  debugResolve(workspace: { id: string; name: string; repo?: string | null }): ResolveDebugInfo;
  listLocalDirectories(): string[];
  getPathOverrides(): Record<string, string>;
  setPathOverride(workspaceName: string, localPath: string): void;
  scanGitRepos(): GitRepoInfo[];
  getProjectRoots(): string[];
}

// Common project locations to auto-discover
const DEFAULT_PROJECT_PATHS = [
  '/home/coder/project',
  join(homedir(), 'projects'),
  join(homedir(), 'dev'),
  join(homedir(), 'code'),
  join(homedir(), 'src'),
  join(homedir(), 'repos'),
  join(homedir(), 'workspace'),
  join(homedir(), 'work'),
  homedir(), // Fallback to home directory
];

// Expand tilde to home directory
function expandTilde(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  if (p === '~') {
    return homedir();
  }
  return p;
}

// Parse PROJECTS_ROOT which can be comma-separated or single path
export function parseProjectRoots(envValue: string | undefined): string[] {
  if (!envValue) {
    // Auto-discover from common locations
    const found = DEFAULT_PROJECT_PATHS.filter(p => existsSync(p));
    if (found.length > 0) {
      console.log(`Auto-discovered project roots: ${found.join(', ')}`);
    }
    return found;
  }

  // Support comma-separated paths with tilde expansion
  const paths = envValue
    .split(',')
    .map(p => resolve(expandTilde(p.trim())))
    .filter(p => {
      if (!existsSync(p)) {
        console.warn(`Project root does not exist: ${p}`);
        return false;
      }
      return true;
    });

  console.log(`Using project roots: ${paths.join(', ')}`);
  return paths;
}

export interface GitRepoInfo {
  path: string;
  remoteUrl: string | null;
  normalizedUrl: string | null;
}

export interface ResolveDebugInfo {
  workspace: { id: string; name: string; repo?: string | null };
  projectsRoot: string;
  attemptedPaths: { path: string; exists: boolean; method: string }[];
  resolvedPath: string | null;
  availableDirectories: string[];
  gitRepos?: GitRepoInfo[];
}

// Path overrides: workspace name -> local path
const pathOverrides: Record<string, string> = {};

// Cache git remotes for performance (cleared on each resolve-all)
let gitRemoteCache: Map<string, string | null> | null = null;

// Normalize git URL to comparable format (owner/repo)
function normalizeGitUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  // Handle various formats:
  // - https://github.com/owner/repo.git
  // - https://github.com/owner/repo
  // - git@github.com:owner/repo.git
  // - owner/repo

  let normalized = url
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^/]+\//, '')  // Remove https://github.com/
    .replace(/^git@[^:]+:/, '');          // Remove git@github.com:

  // If it's already in owner/repo format, return as-is
  if (normalized.match(/^[\w.-]+\/[\w.-]+$/)) {
    return normalized.toLowerCase();
  }

  return null;
}

// Get git remote URL for a directory
function getGitRemote(dirPath: string): string | null {
  try {
    const result = execSync('git remote get-url origin', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export function createWorkspaceResolver(projectRoots: string | string[]): WorkspaceResolver {
  // Normalize to array
  const roots = Array.isArray(projectRoots) ? projectRoots : [projectRoots];

  // Build git remote cache for all directories across all roots
  const buildGitCache = (): Map<string, string | null> => {
    const cache = new Map<string, string | null>();

    for (const root of roots) {
      try {
        if (!existsSync(root)) continue;

        const dirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'));

        for (const dir of dirs) {
          const dirPath = join(root, dir.name);
          const remote = getGitRemote(dirPath);
          cache.set(dirPath, remote);
        }
      } catch {
        // Ignore errors for this root
      }
    }
    return cache;
  };

  // Lazily initialize cache
  const getGitCache = (): Map<string, string | null> => {
    if (!gitRemoteCache) {
      gitRemoteCache = buildGitCache();
    }
    return gitRemoteCache;
  };

  const attemptResolve = (workspace: { id: string; name: string; repo?: string | null }): { path: string | null; attempts: ResolveDebugInfo['attemptedPaths'] } => {
    const attempts: ResolveDebugInfo['attemptedPaths'] = [];

    // Check path override first
    if (pathOverrides[workspace.name]) {
      const overridePath = pathOverrides[workspace.name];
      const exists = existsSync(overridePath);
      attempts.push({ path: overridePath, exists, method: 'override' });
      if (exists) return { path: overridePath, attempts };
    }

    // Try git remote matching first (most reliable)
    if (workspace.repo) {
      const normalizedTarget = normalizeGitUrl(workspace.repo);
      if (normalizedTarget) {
        const cache = getGitCache();
        for (const [dirPath, remoteUrl] of cache) {
          const normalizedRemote = normalizeGitUrl(remoteUrl);
          if (normalizedRemote === normalizedTarget) {
            attempts.push({ path: dirPath, exists: true, method: 'git-remote' });
            return { path: dirPath, attempts };
          }
        }
        // Log that we tried git matching but found no match
        attempts.push({ path: `git:${normalizedTarget}`, exists: false, method: 'git-remote' });
      }
    }

    // Try name-based matching across all roots
    for (const root of roots) {
      if (!existsSync(root)) continue;

      // Check by workspace ID
      if (workspace.id) {
        const byId = join(root, workspace.id);
        const exists = existsSync(byId);
        attempts.push({ path: byId, exists, method: 'id' });
        if (exists) return { path: byId, attempts };
      }

      // Try workspace name directly
      const byName = join(root, workspace.name);
      const nameExists = existsSync(byName);
      attempts.push({ path: byName, exists: nameExists, method: 'name' });
      if (nameExists) {
        return { path: byName, attempts };
      }

      // Try extracting repo name from URL
      if (workspace.repo) {
        const repoName = workspace.repo.split('/').pop()?.replace('.git', '');
        if (repoName) {
          const byRepo = join(root, repoName);
          const repoExists = existsSync(byRepo);
          attempts.push({ path: byRepo, exists: repoExists, method: 'repo-name' });
          if (repoExists) {
            return { path: byRepo, attempts };
          }
        }
      }

      // Try lowercase
      const byLower = join(root, workspace.name.toLowerCase());
      const lowerExists = existsSync(byLower);
      attempts.push({ path: byLower, exists: lowerExists, method: 'lowercase' });
      if (lowerExists) {
        return { path: byLower, attempts };
      }

      // Try kebab-case
      const kebab = workspace.name.toLowerCase().replace(/\s+/g, '-');
      const byKebab = join(root, kebab);
      const kebabExists = existsSync(byKebab);
      attempts.push({ path: byKebab, exists: kebabExists, method: 'kebab-case' });
      if (kebabExists) {
        return { path: byKebab, attempts };
      }
    }

    return { path: null, attempts };
  };

  const listDirs = (): string[] => {
    const allDirs: string[] = [];
    for (const root of roots) {
      try {
        if (!existsSync(root)) continue;
        const dirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .map(d => d.name);
        allDirs.push(...dirs);
      } catch {
        // Ignore errors
      }
    }
    return [...new Set(allDirs)]; // Dedupe
  };

  const scanGitRepos = (): GitRepoInfo[] => {
    const repos: GitRepoInfo[] = [];
    for (const root of roots) {
      try {
        if (!existsSync(root)) continue;
        const dirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'));

        for (const dir of dirs) {
          const dirPath = join(root, dir.name);
          const remoteUrl = getGitRemote(dirPath);
          repos.push({
            path: dirPath,
            remoteUrl,
            normalizedUrl: normalizeGitUrl(remoteUrl),
          });
        }
      } catch {
        // Ignore errors
      }
    }
    return repos;
  };

  return {
    resolve(workspace) {
      const { path } = attemptResolve(workspace);
      if (!path) {
        const dirs = listDirs();
        const normalizedRepo = normalizeGitUrl(workspace.repo);
        console.warn(`Could not resolve workspace: "${workspace.name}" (id: ${workspace.id}, repo: ${workspace.repo || 'none'}, normalized: ${normalizedRepo || 'none'})`);
        console.warn(`  Available directories: ${dirs.join(', ')}`);
        // List git remotes for debugging
        const cache = getGitCache();
        for (const [dirPath, remote] of cache) {
          if (remote) {
            console.warn(`    ${dirPath} -> ${normalizeGitUrl(remote)}`);
          }
        }
      }
      return path;
    },

    debugResolve(workspace) {
      // Clear cache to get fresh data
      gitRemoteCache = null;

      const { path, attempts } = attemptResolve(workspace);
      return {
        workspace,
        projectsRoot: roots.join(', '),
        attemptedPaths: attempts,
        resolvedPath: path,
        availableDirectories: listDirs(),
        gitRepos: scanGitRepos(),
      };
    },

    listLocalDirectories() {
      return listDirs();
    },

    getPathOverrides() {
      return { ...pathOverrides };
    },

    setPathOverride(workspaceName: string, localPath: string) {
      pathOverrides[workspaceName] = localPath;
      // Clear cache when override is set
      gitRemoteCache = null;
      console.log(`Path override set: "${workspaceName}" -> "${localPath}"`);
    },

    scanGitRepos() {
      // Clear cache and rescan
      gitRemoteCache = null;
      return scanGitRepos();
    },

    getProjectRoots() {
      return [...roots];
    },
  };
}
