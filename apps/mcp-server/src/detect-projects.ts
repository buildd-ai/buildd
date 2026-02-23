import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, resolve, basename } from "path";
import { execSync } from "child_process";

export interface DetectedProject {
  name: string;
  path: string;
}

export interface DetectedRepo {
  path: string;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  provider: "github" | "gitlab" | "bitbucket" | "other" | null;
}

/**
 * Parse a git remote URL into owner/repo/provider.
 * Supports GitHub, GitLab, Bitbucket in both HTTPS and SSH formats.
 */
export function parseGitRemoteUrl(url: string): Pick<DetectedRepo, "owner" | "repo" | "provider"> {
  if (!url) return { owner: null, repo: null, provider: null };

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    return {
      owner: sshMatch[2],
      repo: sshMatch[3],
      provider: detectProvider(host),
    };
  }

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)(?:\.git)?(?:\/)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    return {
      owner: httpsMatch[2],
      repo: httpsMatch[3],
      provider: detectProvider(host),
    };
  }

  return { owner: null, repo: null, provider: "other" };
}

function detectProvider(host: string): DetectedRepo["provider"] {
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("bitbucket")) return "bitbucket";
  return "other";
}

/**
 * Get the git remote URL for a directory.
 */
function getGitRemoteUrl(dirPath: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: dirPath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(dirPath: string): boolean {
  return existsSync(join(dirPath, ".git"));
}

/**
 * Scan directories for git repositories and extract remote info.
 * Scans immediate children of each provided root directory.
 */
export function scanGitRepos(roots: string[]): DetectedRepo[] {
  const repos: DetectedRepo[] = [];

  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      const entries = readdirSync(root, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const fullPath = join(root, entry.name);
        if (!isGitRepo(fullPath)) continue;

        const remoteUrl = getGitRemoteUrl(fullPath);
        const parsed = remoteUrl ? parseGitRemoteUrl(remoteUrl) : { owner: null, repo: null, provider: null };

        repos.push({
          path: fullPath,
          remoteUrl,
          ...parsed,
        });
      }
    } catch {
      // Ignore errors for this root
    }
  }

  return repos;
}

/**
 * Detect monorepo projects by reading the root package.json workspaces field
 * and resolving matching directories.
 */
export function detectProjects(rootDir?: string): DetectedProject[] {
  const root = resolve(rootDir || process.cwd());

  let pkg: { name?: string; workspaces?: string[] | { packages: string[] } };
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  } catch {
    return [];
  }

  // Extract workspace globs
  let globs: string[];
  if (Array.isArray(pkg.workspaces)) {
    globs = pkg.workspaces;
  } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
    globs = pkg.workspaces.packages;
  } else {
    // No workspaces — treat root as a single project
    return pkg.name ? [{ name: pkg.name, path: root }] : [];
  }

  const projects: DetectedProject[] = [];

  for (const glob of globs) {
    // Support simple "dir/*" globs only (covers the vast majority of monorepos)
    if (glob.endsWith("/*")) {
      const parentDir = join(root, glob.slice(0, -2));
      let entries: string[];
      try {
        entries = readdirSync(parentDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(parentDir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
          const childPkg = JSON.parse(
            readFileSync(join(fullPath, "package.json"), "utf-8"),
          );
          if (childPkg.name) {
            projects.push({ name: childPkg.name, path: fullPath });
          }
        } catch {
          // No package.json or not a directory — skip
        }
      }
    } else {
      // Exact directory path (no wildcard)
      const fullPath = join(root, glob);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
        const childPkg = JSON.parse(
          readFileSync(join(fullPath, "package.json"), "utf-8"),
        );
        if (childPkg.name) {
          projects.push({ name: childPkg.name, path: fullPath });
        }
      } catch {
        // skip
      }
    }
  }

  return projects;
}
