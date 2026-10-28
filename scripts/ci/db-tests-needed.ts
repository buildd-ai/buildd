#!/usr/bin/env bun
/**
 * Does this pull request need the DB architecture suite (build.yml jobs
 * `db-architecture-plan` -> `db-architecture-shards` -> `db-architecture`)?
 *
 * An allowlist of what CANNOT change its outcome, not a list of what can: the
 * suite runs unless every changed file is one of the paths below. A false
 * positive costs one run; a false negative merges untested SQL. So anything
 * not named here runs it, including paths that look unrelated today.
 *
 * Never safe, whatever the extension:
 *   - packages/**: the schema, migrations (packages/core/drizzle) and the
 *     MCP guidance topics the MCP route reads at request time (*.md);
 *   - .claude/skills/**: the MCP route reads SKILL.md files at request time
 *     (apps/web/next.config.mjs outputFileTracingIncludes);
 *   - docs/specs/**: spec files carry acceptance metadata, and the spec
 *     acceptance step runs alongside the suite.
 * Safe everywhere else:
 *   - docs/** and .claude/** (bar the above);
 *   - *.md, *.css and images (png, jpg, jpeg, gif, svg, webp, ico, avif).
 *
 * Pushes always run: a dev push is the post-merge verdict for its commit.
 * Anything this cannot decide (no base, a failed diff, an empty diff) runs.
 */

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';

const NEVER_SAFE = /^(packages\/|\.claude\/skills\/|docs\/specs\/)/;
const SAFE_TREE = /^(docs\/|\.claude\/)/;
const SAFE_FILE = /\.(md|css|png|jpe?g|gif|svg|webp|ico|avif)$/i;

export function isDbSafePath(path: string): boolean {
  if (NEVER_SAFE.test(path)) return false;
  return SAFE_TREE.test(path) || SAFE_FILE.test(path);
}

export type DbTestsDecision = { run: boolean; reason: string };

export function decideDbTests(input: { event: string; changed: readonly string[] | null }): DbTestsDecision {
  if (input.event !== 'pull_request') return { run: true, reason: `${input.event || 'unknown event'}: always runs` };
  if (input.changed === null) return { run: true, reason: 'could not diff against the base: running' };
  const changed = input.changed.filter(Boolean);
  if (changed.length === 0) return { run: true, reason: 'empty diff against the base: running' };
  const needs = changed.filter(p => !isDbSafePath(p));
  if (needs.length > 0) {
    const shown = needs.slice(0, 5).join(', ') + (needs.length > 5 ? ` (+${needs.length - 5} more)` : '');
    return { run: true, reason: `server/DB-relevant change: ${shown}` };
  }
  return { run: false, reason: `skipped: no server/DB code changed (${changed.length} file(s), all docs, styling or images)` };
}

function changedFiles(base: string): string[] | null {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const baseRef = process.env.BASE_REF ?? '';
  const changed = event === 'pull_request' ? (baseRef ? changedFiles(`origin/${baseRef}`) : null) : [];
  const decision = decideDbTests({ event, changed });
  console.log(`::notice::DB architecture: run=${decision.run} (${decision.reason})`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `run=${decision.run}\nreason=${decision.reason.replace(/[\r\n]+/g, ' ')}\n`);
}
