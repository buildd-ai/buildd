import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

/**
 * buildd no longer stores, refreshes or hands out a subscription login, so the
 * routes that did must 404. In the app router a path 404s when no route module
 * matches it: neither its own `route.ts` nor a catch-all segment above it.
 */

const API_DIR = import.meta.dir;

const REMOVED = [
  'runner/credential-lease',
  'runner/credential-refresh',
  'cron/lease-expiry-guard',
  'workspaces/[id]/claude-credential',
  'workspaces/[id]/claude-credential/oauth/start',
  'workspaces/[id]/claude-credential/oauth/exchange',
  'workspaces/[id]/claude-credential/refresh',
  'workspaces/[id]/codex-credential',
  'workspaces/[id]/codex-credential/device/start',
  'workspaces/[id]/codex-credential/device/poll',
  'workspaces/[id]/codex-credential/refresh',
  'workspaces/[id]/codex-credential/verify',
  'workspaces/[id]/codex-credential/write-back',
];

const isCatchAll = (segment: string) => segment.startsWith('[...') || segment.startsWith('[[...');

describe('removed subscription-login routes', () => {
  for (const path of REMOVED) {
    it(`/api/${path} has no route module, so it 404s`, () => {
      expect(existsSync(resolve(API_DIR, path, 'route.ts'))).toBe(false);

      // No catch-all on the way down would pick the path up instead.
      const segments = path.split('/');
      for (let i = 0; i < segments.length; i++) {
        const parent = resolve(API_DIR, ...segments.slice(0, i));
        if (!existsSync(parent)) break;
        const catchAlls = readdirSync(parent, { withFileTypes: true })
          .filter(d => d.isDirectory() && isCatchAll(d.name))
          .map(d => d.name);
        expect(catchAlls, `catch-all under /api/${segments.slice(0, i).join('/')}`).toEqual([]);
      }
    });
  }
});
