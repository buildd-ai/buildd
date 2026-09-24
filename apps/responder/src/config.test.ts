import { describe, expect, test } from 'bun:test';
import { loadConfig, MISSING_NOTIFY_MESSAGE } from './config';
import { TIER_DEFAULTS } from '../../../packages/core/model-tier-defaults';
import { DEFAULT_ROLE_REGRESSION } from './detectors/role-regression';

const MINIMAL = {
  BUILDD_RESPONDER_STATE_DIR: '/tmp/responder-test',
  BUILDD_RESPONDER_APP_URL: 'https://app.example.test',
  BUILDD_RESPONDER_API_KEY: 'bld_illustrative',
  PUSHOVER_USER: 'illustrative-user',
  PUSHOVER_TOKEN: 'illustrative-token',
};

describe('loadConfig', () => {
  test('a state dir outside the production database is required, and is local', () => {
    const cfg = loadConfig(MINIMAL);
    expect(cfg.stateDir).toBe('/tmp/responder-test');
  });

  test('refuses to start without a notification path', () => {
    const { PUSHOVER_USER: _u, PUSHOVER_TOKEN: _t, ...noNotify } = MINIMAL;
    expect(() => loadConfig(noNotify)).toThrow(MISSING_NOTIFY_MESSAGE);
  });

  test('starts without any model credential — the narrative is optional', () => {
    const cfg = loadConfig(MINIMAL);
    expect(cfg.narrative).toBeNull();
    expect(cfg.notify).not.toBeNull();
  });

  test('reuses the platform OAuth credential rather than a responder-specific one', () => {
    const cfg = loadConfig({ ...MINIMAL, CLAUDE_CODE_OAUTH_TOKEN: 'illustrative-oauth' });
    expect(cfg.narrative).toEqual({ kind: 'oauth', token: 'illustrative-oauth' });
  });

  test('accepts an API key for the narrative when that is what the host has', () => {
    const cfg = loadConfig({ ...MINIMAL, ANTHROPIC_API_KEY: 'illustrative-api-key' });
    expect(cfg.narrative).toEqual({ kind: 'api-key', token: 'illustrative-api-key' });
  });

  test('prefers the OAuth credential when both are present', () => {
    const cfg = loadConfig({
      ...MINIMAL,
      CLAUDE_CODE_OAUTH_TOKEN: 'illustrative-oauth',
      ANTHROPIC_API_KEY: 'illustrative-api-key',
    });
    expect(cfg.narrative?.kind).toBe('oauth');
  });

  test('the narrative model defaults to the premium tier, not a pinned ID', () => {
    // A literal here goes stale silently when the tier moves a generation.
    expect(loadConfig(MINIMAL).narrativeModel).toBe(TIER_DEFAULTS.premium.model);
  });

  test('the narrative model can be overridden', () => {
    const cfg = loadConfig({ ...MINIMAL, BUILDD_RESPONDER_NARRATIVE_MODEL: 'override-model' });
    expect(cfg.narrativeModel).toBe('override-model');
  });

  test('the cron_runs feed is optional and absent by default', () => {
    expect(loadConfig(MINIMAL).cronRunsUrl).toBeNull();
  });

  test('carries no default that points at production', () => {
    // A default app URL would make a misconfigured responder probe prod by
    // accident; a default DATABASE_URL would make it read prod by accident.
    const { BUILDD_RESPONDER_APP_URL: _a, ...noUrl } = MINIMAL;
    expect(() => loadConfig(noUrl)).toThrow(/BUILDD_RESPONDER_APP_URL/);
  });

  test('never reads DATABASE_URL — the feed has its own, read-only variable', () => {
    const cfg = loadConfig({ ...MINIMAL, DATABASE_URL: 'postgres://should-be-ignored/x' });
    expect(cfg.cronRunsUrl).toBeNull();
  });

  test('renotify window matches the queue-stall convention', () => {
    // apps/web/src/app/api/cron/queue-stall/route.ts → RENOTIFY_HOURS = 24.
    expect(loadConfig(MINIMAL).renotifyHours).toBe(24);
  });

  test('numeric overrides are parsed, and nonsense is rejected rather than defaulted', () => {
    expect(loadConfig({ ...MINIMAL, BUILDD_RESPONDER_INTERVAL_SECONDS: '30' }).intervalSeconds).toBe(30);
    expect(() => loadConfig({ ...MINIMAL, BUILDD_RESPONDER_INTERVAL_SECONDS: 'soon' })).toThrow(
      /BUILDD_RESPONDER_INTERVAL_SECONDS/,
    );
    expect(() => loadConfig({ ...MINIMAL, BUILDD_RESPONDER_INTERVAL_SECONDS: '0' })).toThrow(
      /BUILDD_RESPONDER_INTERVAL_SECONDS/,
    );
  });

  test('role-regression thresholds default to the detector\'s own and can be overridden', () => {
    expect(loadConfig(MINIMAL).roleRegression).toEqual({ ...DEFAULT_ROLE_REGRESSION });
    const cfg = loadConfig({
      ...MINIMAL,
      BUILDD_RESPONDER_ROLE_MIN_RECENT: '6',
      BUILDD_RESPONDER_ROLE_RECENT_FLOOR_PCT: '0',
      BUILDD_RESPONDER_ROLE_BASELINE_BAR_PCT: '80',
      BUILDD_RESPONDER_ROLE_BASELINE_MIN: '20',
      BUILDD_RESPONDER_ROLE_DOMINANT_SHARE_PCT: '75',
    }).roleRegression;
    expect(cfg).toEqual({ minRecent: 6, recentFloorPct: 0, baselineBarPct: 80, baselineMin: 20, dominantSharePct: 75 });
  });

  test('a role-regression percentage outside 0-100 is rejected, not clamped', () => {
    expect(() => loadConfig({ ...MINIMAL, BUILDD_RESPONDER_ROLE_BASELINE_BAR_PCT: '170' })).toThrow(
      /BUILDD_RESPONDER_ROLE_BASELINE_BAR_PCT/,
    );
    expect(() => loadConfig({ ...MINIMAL, BUILDD_RESPONDER_ROLE_MIN_RECENT: '0' })).toThrow(
      /BUILDD_RESPONDER_ROLE_MIN_RECENT/,
    );
  });
});
