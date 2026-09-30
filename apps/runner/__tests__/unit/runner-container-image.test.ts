/**
 * Keeps the --once container image (apps/runner/Dockerfile.once), its env
 * contract doc (docs/runner-container.md) and the agent env allowlist in step.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RUNNER_ENV_PASSTHROUGH } from '../../src/agent-env';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const dockerfile = readFileSync(join(ROOT, 'apps/runner/Dockerfile.once'), 'utf8');
const doc = readFileSync(join(ROOT, 'docs/runner-container.md'), 'utf8');
const helper = readFileSync(join(ROOT, 'apps/runner/scripts/buildd-once.sh'), 'utf8');

/** KEY=value pairs from every ENV instruction (continuation lines included). */
function envKeys(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const joined = src.replace(/\\\n/g, ' ');
  for (const line of joined.split('\n')) {
    const m = line.match(/^ENV\s+(.*)$/);
    if (!m) continue;
    for (const pair of m[1].trim().split(/\s+/)) {
      const [k, v] = pair.split('=');
      if (k) out[k] = v ?? '';
    }
  }
  return out;
}

describe('runner --once container image', () => {
  const env = envKeys(dockerfile);

  it('copies every workspace manifest, so --frozen-lockfile matches bun.lock', () => {
    // bun checks the lockfile against all workspaces; a new apps/* or packages/*
    // entry without a COPY here fails the image build, not this repo's CI.
    const manifests = ['apps', 'packages'].flatMap(dir =>
      readdirSync(join(ROOT, dir))
        .map(name => `${dir}/${name}/package.json`)
        .filter(p => existsSync(join(ROOT, p))));
    expect(manifests).toContain('apps/cloud-runner/package.json');
    for (const m of manifests) expect(dockerfile).toContain(`COPY ${m} ${m}`);
  });

  it('turns off self-update and non-essential Claude Code traffic', () => {
    expect(env.BUILDD_DISABLE_AUTO_UPDATE).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('only bakes in agent-facing Claude Code vars that the allowlist lets through', () => {
    for (const key of Object.keys(env).filter(k => k.startsWith('CLAUDE_CODE_'))) {
      expect(RUNNER_ENV_PASSTHROUGH.has(key)).toBe(true);
    }
  });

  it('documents every env var the image sets', () => {
    for (const key of Object.keys(env)) expect(doc).toContain(`\`${key}\``);
  });

  it('runs as a non-root user and idles for exec', () => {
    expect(dockerfile).toMatch(/^USER bun$/m);
    expect(dockerfile).toMatch(/^CMD \["sleep", "infinity"\]$/m);
  });

  it('helper runs the runner in --once mode from the repo root', () => {
    expect(helper).toContain('cd "${BUILDD_REPO_ROOT:-/opt/buildd}"');
    expect(helper).toContain('exec bun run apps/runner/src/index.ts --once "$@"');
  });
});
