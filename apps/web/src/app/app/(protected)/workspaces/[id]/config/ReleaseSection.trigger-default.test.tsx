import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ReleaseSection from './ReleaseSection';
import { resolveReleaseTrigger } from '@buildd/core/release-strategy';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';

/**
 * Invariant 4 of docs/design/mission-delivery-arc.md:
 * the UI never displays a policy default the server does not use.
 *
 * The server's effective trigger for a config with no explicit `trigger` is
 * 'every_merge'. That default is read in three places:
 *   - apps/web/src/lib/mission-release.ts
 *   - apps/web/src/lib/release-executor.ts
 *   - apps/web/src/app/api/github/webhook/route.ts
 * `resolveReleaseTrigger` is the single source of that default; the form must
 * not re-guess it.
 */
const SERVER_DEFAULT_TRIGGER = 'every_merge';

// Config with a strategy but NO explicit trigger — the drift case.
const noTriggerConfig: WorkspaceReleaseConfig = {
  enabled: true,
  strategy: 'workflow_dispatch',
  workflowFile: 'release.yml',
  ref: 'dev',
};

/** value -> whether the rendered radio input carries `checked`. */
function radioChecked(html: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const tag of html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []) {
    const value = /value="([^"]*)"/.exec(tag)?.[1];
    if (value) out[value] = /\schecked(=|\s|\/|>)/.test(tag);
  }
  return out;
}

describe('resolveReleaseTrigger — single source of the trigger default', () => {
  it('resolves an absent trigger to the server default', () => {
    expect(resolveReleaseTrigger(noTriggerConfig)).toBe(SERVER_DEFAULT_TRIGGER);
    expect(resolveReleaseTrigger({ enabled: true })).toBe(SERVER_DEFAULT_TRIGGER);
  });

  it('resolves a null/undefined config to the server default', () => {
    expect(resolveReleaseTrigger(null)).toBe(SERVER_DEFAULT_TRIGGER);
    expect(resolveReleaseTrigger(undefined)).toBe(SERVER_DEFAULT_TRIGGER);
  });

  it('passes an explicit trigger through untouched', () => {
    expect(resolveReleaseTrigger({ enabled: true, trigger: 'on_mission_complete' })).toBe(
      'on_mission_complete',
    );
    expect(resolveReleaseTrigger({ enabled: true, trigger: 'manual' })).toBe('manual');
  });
});

describe('ReleaseSection — displayed trigger matches the policy the server runs', () => {
  it('preselects the resolved default when the config has no explicit trigger', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection
        workspaceId="ws-1"
        teamId="team-1"
        initialReleaseConfig={noTriggerConfig}
        effectiveTrigger={resolveReleaseTrigger(noTriggerConfig)}
        hasRepo={true}
      />,
    );
    const checked = radioChecked(html);
    expect(checked[SERVER_DEFAULT_TRIGGER]).toBe(true);
    expect(checked['on_mission_complete']).toBe(false);
  });

  it('still honours an explicit trigger', () => {
    const cfg: WorkspaceReleaseConfig = { ...noTriggerConfig, trigger: 'on_mission_complete' };
    const html = renderToStaticMarkup(
      <ReleaseSection
        workspaceId="ws-1"
        teamId="team-1"
        initialReleaseConfig={cfg}
        effectiveTrigger={resolveReleaseTrigger(cfg)}
        hasRepo={true}
      />,
    );
    const checked = radioChecked(html);
    expect(checked['on_mission_complete']).toBe(true);
    expect(checked[SERVER_DEFAULT_TRIGGER]).toBe(false);
  });
});
