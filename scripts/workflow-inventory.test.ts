import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * The workflow inventory. Every file under .github/workflows is listed here with
 * the tier it belongs to, so adding a workflow is a reviewed edit to this file
 * rather than a quiet new entry in the Actions sidebar (the failure mode behind
 * the scratch-workflow cleanups). Prefer a job in an existing workflow in the
 * same tier over a new file.
 *
 * Tiers:
 *   gate     fast required PR/push checks
 *   deploy   reacts to a deployment or a push to a release branch
 *   verify   post-merge/post-deploy integration verification
 *   smoke    scheduled external-provider smoke
 *   release  release cutting and publishing
 *   manual   diagnostics run by hand (workflow_dispatch only)
 *   internal reusable (workflow_call) or housekeeping
 */
const INVENTORY: Record<string, string> = {
  'build.yml': 'gate',
  'no-prod-data.yml': 'gate',
  'spec-conformance-check.yml': 'gate',
  'installer-smoke.yml': 'gate',
  'neon-cleanup.yml': 'internal',
  'visual-qa.yml': 'manual',
  'knowledge-eval.yml': 'gate',
  'integration.yml': 'internal',
  'post-merge-integration.yml': 'verify',
  'post-deploy.yml': 'verify',
  'deploy-control-plane.yml': 'deploy',
  'deploy-dispatch.yml': 'deploy',
  'deploy-model-policy.yml': 'deploy',
  'claude-artifact-smoke.yml': 'smoke',
  'mirror-ci-images.yml': 'internal',
  'spec-discrepancy-ledger.yml': 'verify',
  'ci-fix.yml': 'internal',
  'sync-dev.yml': 'internal',
  'release.yml': 'release',
  'release-refresh.yml': 'release',
  'release-tag.yml': 'release',
  'publish-ai-kit.yml': 'release',
  'publish-runner-image.yml': 'release',
  'verify-unit-tests.yml': 'manual',
};

function tracked(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z', '.github/workflows'], { encoding: 'utf8' });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(f => f.replace('.github/workflows/', ''));
}

describe('workflow inventory', () => {
  test('every workflow file is listed, and every listed file exists', () => {
    expect(tracked().sort()).toEqual(Object.keys(INVENTORY).sort());
  });

  test('a manual-tier workflow has no automatic trigger', () => {
    for (const [file, tier] of Object.entries(INVENTORY)) {
      if (tier !== 'manual') continue;
      const parsed = Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as any;
      const on = parsed.on ?? parsed[true as unknown as string];
      const keys = typeof on === 'string' ? [on] : Object.keys(on ?? {});
      const auto = keys.filter(k => k !== 'workflow_dispatch' && k !== 'pull_request');
      expect(auto, `${file} is manual-tier but triggers on ${auto}`).toEqual([]);
    }
  });

  test('scheduled workflows do not share a cron minute', () => {
    const seen = new Map<string, string>();
    for (const file of tracked()) {
      const parsed = Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as any;
      const on = parsed.on ?? parsed[true as unknown as string] ?? {};
      for (const s of on.schedule ?? []) {
        const prior = seen.get(s.cron);
        expect(prior, `${file} and ${prior} both run at '${s.cron}'`).toBeUndefined();
        seen.set(s.cron, file);
      }
    }
  });

  test('post-deploy owns every Production deployment_status reaction', () => {
    const offenders = tracked().filter(file => {
      if (file === 'post-deploy.yml' || file === 'deploy-control-plane.yml') return false;
      const parsed = Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as any;
      const on = parsed.on ?? parsed[true as unknown as string] ?? {};
      return typeof on === 'object' && 'deployment_status' in on;
    });
    expect(offenders).toEqual([]);
  });
});
