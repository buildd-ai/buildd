import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  HEADLESS_SESSION_ENV,
  HEADLESS_DENIED_TOOLS,
  applyHeadlessSessionEnv,
  withHeadlessToolDeny,
} from './headless-session';

describe('headless session: nothing can wake a session that ended its turn', () => {
  it('turns off background tasks and scheduled wakeups in the agent env', () => {
    const env = applyHeadlessSessionEnv({ HOME: '/home/bun' });
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
    expect(env.HOME).toBe('/home/bun');
  });

  it('overrides an operator value that would turn them back on', () => {
    const env = applyHeadlessSessionEnv({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' });
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('denies the wakeup and cron tools, keeping whatever was already denied', () => {
    const out = withHeadlessToolDeny(['Bash(gh pr merge:*)']);
    expect(out).toContain('Bash(gh pr merge:*)');
    for (const t of ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList']) expect(out).toContain(t);
  });

  it('starts from nothing and never duplicates an entry', () => {
    expect(withHeadlessToolDeny(undefined)).toEqual([...HEADLESS_DENIED_TOOLS]);
    expect(withHeadlessToolDeny(['ScheduleWakeup']).filter(t => t === 'ScheduleWakeup')).toHaveLength(1);
  });
});

// Pin the property, not the version: these switches only work while the
// Claude Code the runner installs still reads them. The SDK bundle lists the
// env vars its CLI recognises; if a bump drops one, this fails instead of
// sessions silently going back to ending mid-wait.
describe('the installed Claude Agent SDK still recognises the headless switches', () => {
  function sdkDir(): string | null {
    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 6; i++) {
      const store = join(dir, 'node_modules', '.bun');
      if (existsSync(store)) {
        const pkg = readdirSync(store).filter(d => d.startsWith('@anthropic-ai+claude-agent-sdk@')).sort().pop();
        if (pkg) return join(store, pkg, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      }
      dir = dirname(dir);
    }
    return null;
  }

  it('names every HEADLESS_SESSION_ENV key', () => {
    const dir = sdkDir();
    expect(dir).not.toBeNull();
    const bundle = readFileSync(join(dir!, 'sdk.mjs'), 'utf8');
    for (const key of Object.keys(HEADLESS_SESSION_ENV)) expect(bundle).toContain(`"${key}"`);
  });
});
