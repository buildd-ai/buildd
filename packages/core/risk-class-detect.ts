/**
 * Risk-class path detection — pure, no fs, no fetch.
 *
 * The single implementation behind both `manage_workspaces action=init` (via
 * `apps/web/src/lib/workspace-policy.ts`, which re-exports it) and the workspace
 * readiness report. Lives in core so a pure detector can reuse it without
 * importing from an app.
 */

import type { RiskClassName, RiskClassEntry } from '@buildd/shared';

/**
 * How a matcher's hits are stored.
 *
 *   - `dir`:  the regex's first capture group is the matched directory
 *             (ending in `/`). Stored as that prefix so future files in the
 *             same directory are covered. Never widened to the parent — a
 *             `lib/auth/` hit must not become `lib/`.
 *   - `file`: the file path itself is stored, verbatim. A single-file hit
 *             (`middleware.ts`, `vercel.json`, `db/schema.ts`) collapsed to
 *             its parent would put every sibling behind the class — one
 *             middleware file would escalate the whole app.
 */
export type ClassMatcher = { kind: 'dir' | 'file'; rx: RegExp };

const dir = (rx: RegExp): ClassMatcher => ({ kind: 'dir', rx });
const file = (rx: RegExp): ClassMatcher => ({ kind: 'file', rx });

/** Regex tests that classify a file path into a risk class. */
export const CLASS_MATCHERS: Record<RiskClassName, ClassMatcher[]> = {
  destructive_schema_change: [
    // Drizzle: any directory named "drizzle" that contains numbered SQL migrations
    dir(/^((?:.*\/)?drizzle\/)\d+_/),
    // Prisma: prisma/migrations
    dir(/^((?:.*\/)?prisma\/migrations?\/)/),
    // Alembic
    dir(/^((?:.*\/)?alembic\/versions?\/)/),
    // Generic: a "migrations" dir with SQL files
    dir(/^((?:.*\/)?migrations?\/)[^/]+\.sql$/),
    // Schema source files (ORM definitions)
    file(/(?:^|\/)(?:db\/schema|models\/schema|prisma\/schema)\.(?:ts|js|prisma)$/),
  ],
  ci_deploy_config: [
    dir(/^(\.github\/workflows\/)/),
    dir(/^(\.github\/actions\/)/),
    dir(/^(\.circleci\/)/),
    file(/^\.gitlab-ci\.ya?ml$/),
    file(/^Jenkinsfile/),
    file(/(?:^|\/)vercel\.json$/),
    file(/(?:^|\/)netlify\.toml$/),
    file(/(?:^|\/)Dockerfile(?:\.\w+)?$/),
    file(/(?:^|\/)docker-compose(?:\.override)?\.ya?ml$/),
    file(/(?:^|\/)railway\.toml$/),
    file(/(?:^|\/)fly\.toml$/),
    file(/(?:^|\/)render\.ya?ml$/),
  ],
  auth_and_secrets: [
    // Auth directories
    dir(/^((?:.*\/)?(?:lib|src)\/auth\/)/),
    dir(/^((?:.*\/)?(?:lib|src)\/authentication\/)/),
    file(/(?:^|\/)(?:lib|src)\/auth(?:entication)?$/),
    file(/(?:^|\/)middleware\.(?:ts|js)$/),
    // Env schema files (typed env loaders)
    file(/(?:^|\/)(?:env|config)\.(?:schema|types?)\.(?:ts|js)$/),
    file(/(?:^|\/)(?:src|lib)\/env\.(?:ts|js)$/),
    dir(/^((?:.*\/)?(?:src|lib)\/env\/)/),
    // Secret loaders
    dir(/^((?:.*\/)?(?:secrets?|credentials?)\/)[^/]+\.(?:ts|js)$/),
  ],
  dependency_bump: [
    // Lockfiles
    file(
      /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock)$/,
    ),
    // Manifest (coarser — only match at root)
    file(/^package\.json$/),
  ],
  public_api_contract: [
    // OpenAPI / Swagger specs
    file(/(?:^|\/)openapi(?:\.v\d+)?\.(?:ya?ml|json)$/),
    file(/(?:^|\/)swagger(?:\.v\d+)?\.(?:ya?ml|json)$/),
    // Shared type packages (mono-repo convention)
    dir(/^(packages\/shared\/src\/)/),
    dir(/^(packages\/types\/src\/)/),
    dir(/^(packages\/api-types\/src\/)/),
    // Public-surface type roots
    dir(/^((?:.*\/)?types\/(?:api|public|shared)\/)/),
  ],
};

/**
 * Given a full repo file listing, return the paths that satisfy the given
 * risk class: directory prefixes (ending in `/`) for directory-form matchers,
 * exact file paths for file-form matchers.
 *
 * Deduplication: a prefix inside another kept prefix is dropped, and a file
 * already covered by a kept prefix is dropped.
 */
export function detectRiskClassPaths(files: string[], className: RiskClassName): string[] {
  const matchers = CLASS_MATCHERS[className];
  const dirs = new Set<string>();
  const exact = new Set<string>();
  for (const f of files) {
    for (const m of matchers) {
      const hit = m.rx.exec(f);
      if (!hit) continue;
      if (m.kind === 'dir' && hit[1]) dirs.add(hit[1]);
      else exact.add(f);
      break;
    }
  }

  const keptDirs: string[] = [];
  for (const d of [...dirs].sort()) {
    if (!keptDirs.some((prev) => d.startsWith(prev))) keptDirs.push(d);
  }
  const keptFiles = [...exact].filter((f) => !keptDirs.some((d) => f.startsWith(d)));
  return [...keptDirs, ...keptFiles].sort();
}

/** Detect all risk classes in one pass over the file listing. */
export function detectAllRiskClasses(files: string[]): RiskClassEntry[] {
  const classNames: RiskClassName[] = [
    'destructive_schema_change',
    'ci_deploy_config',
    'auth_and_secrets',
    'dependency_bump',
    'public_api_contract',
  ];
  return classNames.map((name) => ({
    name,
    detectedPaths: detectRiskClassPaths(files, name),
  }));
}

