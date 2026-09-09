import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Two ways a GitHub Actions workflow in this repo can destroy work, both of
 * which have actually happened, and neither of which any other gate catches.
 *
 * 1. Force-pushing a long-lived branch. `sync-dev.yml` used to reset `dev` to
 *    `main` whenever the two diverged. It fired on 2026-08-29 after a hotfix
 *    merged straight to `main` and flattened `dev` — the origin of the
 *    recurring "phantom upstream commits, every PR conflicts" symptom.
 *
 * 2. Acting on a `delete` event without checking the ref. GitHub's `delete`
 *    event does NOT support a `branches:` filter: it is accepted and silently
 *    ignored. `delete: { branches: [dev] }` therefore fires for every branch
 *    deleted in the repo, and since merged PRs auto-delete their head branch,
 *    that was 87 of 100 runs. A workflow that only *reads* is merely wasteful;
 *    one that writes is a loaded gun pointed at whatever it thinks it is
 *    reconciling.
 *
 * These assert on the parsed YAML, not on grep, so a reformat cannot quietly
 * defeat them.
 */

const PROTECTED_BRANCHES = ['dev', 'main'];

function workflowFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z', '.github/workflows'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return (ls.stdout ?? '').split('\0').filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
}

/** Every `run:` script body in the workflow, with comment-only lines removed. */
function runScripts(parsed: any): string[] {
  const out: string[] = [];
  for (const job of Object.values<any>(parsed?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === 'string') {
        out.push(
          step.run
            .split('\n')
            .filter((l: string) => !/^\s*#/.test(l))
            .join('\n'),
        );
      }
    }
  }
  return out;
}

/** `on:` parses as the boolean `true` in YAML 1.1 — hence the lookup dance. */
function triggers(parsed: any): Record<string, any> {
  const on = parsed?.on ?? parsed?.[true as unknown as string] ?? parsed?.['on'];
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((k: string) => [k, null]));
  return on ?? {};
}

const parsedWorkflows = () =>
  workflowFiles().map(file => ({
    file,
    parsed: Bun.YAML.parse(readFileSync(file, 'utf8')) as any,
  }));

describe('workflow safety', () => {
  test('finds the workflows at all', () => {
    // A path typo would make every assertion below vacuously true — the
    // failure mode these gates exist to prevent.
    expect(workflowFiles().length).toBeGreaterThan(5);
  });

  test('no workflow force-pushes a long-lived branch', () => {
    const offenders: string[] = [];
    for (const { file, parsed } of parsedWorkflows()) {
      for (const script of runScripts(parsed)) {
        for (const line of script.split('\n')) {
          if (!/git\s+push\b/.test(line)) continue;
          if (!/(--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/.test(line)) continue;
          if (PROTECTED_BRANCHES.some(b => new RegExp(`\\b${b}\\b`).test(line))) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a delete-triggered workflow scopes itself by ref in an if:, not a branches: filter', () => {
    for (const { file, parsed } of parsedWorkflows()) {
      const on = triggers(parsed);
      if (!('delete' in on)) continue;

      // `branches:` under `delete:` reads as a filter and is not one.
      expect(on.delete ?? {}).not.toHaveProperty('branches');

      // Something must actually check the ref. Job-level `if:` is the usual
      // place; a step-level one counts too.
      const jobs = Object.values<any>(parsed?.jobs ?? {});
      const conditions = jobs.flatMap(job => [
        String(job?.if ?? ''),
        ...(job?.steps ?? []).map((s: any) => String(s?.if ?? '')),
      ]);
      const guarded = conditions.some(c => c.includes('github.event.ref'));
      expect(guarded, `${file} has a delete trigger but never checks github.event.ref`).toBe(true);
    }
  });
});
