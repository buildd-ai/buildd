/**
 * A `registry-auth` install block used to read
 *   "Provision failed: dependency install (registry-auth) at ."
 * — no host, no package, no hint which credential was missing, and `.` for the
 * repo root. The fix had to be reverse-engineered from runner logs.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/install-diagnosis.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { diagnoseRegistryAuth, describeInstallFailure, formatInstallDir } from '../../src/install-diagnosis';

// Shape of bun's own output for a GitHub Packages 401.
const BUN_401 =
  'Command failed: bun install --frozen-lockfile\n' +
  'error: GET https://npm.pkg.github.com/download/@acme/private-lib/0.2.0/abcdef - 401';

const files = (map: Record<string, string>) => (rel: string) => map[rel] ?? null;

describe('diagnoseRegistryAuth', () => {
  test('recovers host, package and the .npmrc token env var', () => {
    const d = diagnoseRegistryAuth(BUN_401, '.', files({
      '.npmrc': '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n',
    }), {});

    expect(d).toEqual({
      host: 'npm.pkg.github.com',
      pkg: '@acme/private-lib',
      envVar: 'NODE_AUTH_TOKEN',
      source: '.npmrc',
      envVarSet: false,
    });
  });

  test('reads a bunfig.toml scope token ($VAR form)', () => {
    const d = diagnoseRegistryAuth(BUN_401, '.', files({
      'bunfig.toml': '[install.scopes]\n"@acme" = { token = "$GH_PACKAGES_TOKEN", url = "https://npm.pkg.github.com/" }\n',
    }));

    expect(d.envVar).toBe('GH_PACKAGES_TOKEN');
    expect(d.source).toBe('bunfig.toml');
  });

  test('a nested install dir checks its own config before the root', () => {
    const d = diagnoseRegistryAuth(BUN_401, 'packages/api', files({
      'packages/api/.npmrc': '//npm.pkg.github.com/:_authToken=${API_TOKEN}\n',
      '.npmrc': '//registry.other.example/:_authToken=${OTHER_TOKEN}\n',
    }));

    expect(d.envVar).toBe('API_TOKEN');
    expect(d.source).toBe('packages/api/.npmrc');
  });

  test('prefers the line naming the refused host over an unrelated token line', () => {
    const d = diagnoseRegistryAuth(BUN_401, '.', files({
      '.npmrc': '//registry.other.example/:_authToken=${OTHER_TOKEN}\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n',
    }));

    expect(d.envVar).toBe('NODE_AUTH_TOKEN');
  });

  test('decodes an escaped scope and never echoes userinfo from the URL', () => {
    const d = diagnoseRegistryAuth(
      'error: GET https://user:s3cr3t@npm.pkg.github.com/@acme%2fprivate-lib - 403',
      '.',
      files({}),
    );

    expect(d.host).toBe('npm.pkg.github.com');
    expect(d.pkg).toBe('@acme/private-lib');
    expect(JSON.stringify(d)).not.toContain('s3cr3t');
  });

  test('reports envVarSet without ever carrying the value', () => {
    const d = diagnoseRegistryAuth(BUN_401, '.', files({
      '.npmrc': '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n',
    }), { NODE_AUTH_TOKEN: 'tok-value' });

    expect(d.envVarSet).toBe(true);
    expect(JSON.stringify(d)).not.toContain('tok-value');
  });

  test('commented-out lines are ignored', () => {
    const d = diagnoseRegistryAuth(BUN_401, '.', files({
      '.npmrc': '# //npm.pkg.github.com/:_authToken=${OLD_TOKEN}\n',
    }));

    expect(d.envVar).toBeUndefined();
  });
});

describe('describeInstallFailure', () => {
  test('registry-auth names host, package, env var and the repo root', () => {
    const msg = describeInstallFailure({
      dir: '.',
      failure: 'registry-auth',
      message: BUN_401,
      registry: { host: 'npm.pkg.github.com', pkg: '@acme/private-lib', envVar: 'NODE_AUTH_TOKEN', source: '.npmrc', envVarSet: false },
    });

    expect(msg).toStartWith('Provision failed: dependency install (registry-auth) at repo root');
    expect(msg).toContain('npm.pkg.github.com');
    expect(msg).toContain('@acme/private-lib');
    expect(msg).toContain('$NODE_AUTH_TOKEN');
    expect(msg).toContain('not set');
    expect(msg).not.toMatch(/ at \.(\s|:|$)/);
  });

  test('a set-but-rejected token says so rather than "not set"', () => {
    const msg = describeInstallFailure({
      dir: '.',
      failure: 'registry-auth',
      message: BUN_401,
      registry: { host: 'npm.pkg.github.com', envVar: 'NODE_AUTH_TOKEN', source: '.npmrc', envVarSet: true },
    });

    expect(msg).toContain('set but rejected');
  });

  test('without a diagnosis it still reads, and says no env var was found', () => {
    const msg = describeInstallFailure({ dir: '.', failure: 'registry-auth', message: '401' });

    expect(msg).toContain('the package registry');
    expect(msg).toContain('No token env var');
  });

  test('other failure classes keep the short form', () => {
    expect(describeInstallFailure({ dir: 'packages/api', failure: 'toolchain-missing', message: 'ENOENT' }))
      .toBe('Provision failed: dependency install (toolchain-missing) at packages/api');
  });
});

test('formatInstallDir renders `.` as the repo root', () => {
  expect(formatInstallDir('.')).toBe('repo root');
  expect(formatInstallDir('packages/api')).toBe('packages/api');
});
