/**
 * `buildd name` (spec "Runner on your terminal" R-8..R-10): the name comes from
 * BUILDD_RUNNER_NAME, else ~/.buildd/config.json, else the hostname, and rides
 * the heartbeat as a label without touching the runner's identity.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveRunnerName,
  saveRunnerName,
  runNameCommand,
  runnerConfigFile,
  heartbeatRunnerName,
  withRunnerName,
} from '../../src/runner-name';

let home: string;
let configFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buildd-name-'));
  configFile = join(home, 'config.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('runnerConfigFile', () => {
  test('is config.json under BUILDD_HOME', () => {
    expect(runnerConfigFile({ BUILDD_HOME: home })).toBe(join(home, 'config.json'));
  });

  test('BUILDD_CONFIG names the file directly, as index.ts reads it', () => {
    expect(runnerConfigFile({ BUILDD_HOME: home, BUILDD_CONFIG: join(home, 'other.json') })).toBe(join(home, 'other.json'));
  });
});

describe('resolveRunnerName order', () => {
  test('hostname when nothing is set', () => {
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'laptop-1234' })).toEqual({ name: 'laptop-1234', source: 'hostname' });
  });

  test('config.json name beats the hostname', () => {
    writeFileSync(configFile, JSON.stringify({ apiKey: 'bld_x', name: 'atlas' }));
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'laptop-1234' })).toEqual({ name: 'atlas', source: 'config' });
  });

  test('BUILDD_RUNNER_NAME beats config.json', () => {
    writeFileSync(configFile, JSON.stringify({ name: 'atlas' }));
    expect(resolveRunnerName({ env: { BUILDD_RUNNER_NAME: 'birch' }, configFile, hostname: 'laptop-1234' })).toEqual({ name: 'birch', source: 'env' });
  });

  test('a blank env value or blank stored name falls through', () => {
    writeFileSync(configFile, JSON.stringify({ name: '   ' }));
    expect(resolveRunnerName({ env: { BUILDD_RUNNER_NAME: '  ' }, configFile, hostname: 'laptop-1234' }).source).toBe('hostname');
  });

  test('an unreadable config falls through to the hostname', () => {
    writeFileSync(configFile, '{not json');
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'laptop-1234' }).source).toBe('hostname');
  });
});

describe('saveRunnerName', () => {
  test('keeps every other config field and the owner-only mode', () => {
    writeFileSync(configFile, JSON.stringify({ apiKey: 'bld_x', builddServer: 'https://example.test' }));
    saveRunnerName(configFile, 'atlas');
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(cfg).toEqual({ apiKey: 'bld_x', builddServer: 'https://example.test', name: 'atlas' });
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
  });

  test('null removes the name', () => {
    writeFileSync(configFile, JSON.stringify({ apiKey: 'bld_x', name: 'atlas' }));
    saveRunnerName(configFile, null);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ apiKey: 'bld_x' });
  });

  test('creates the file when there is none', () => {
    saveRunnerName(configFile, 'atlas');
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ name: 'atlas' });
  });
});

describe('runNameCommand', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    runNameCommand(args, { env, configFile, hostname: 'laptop-1234' });

  test('with a name, saves it and says so', () => {
    const r = run(['atlas']);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).name).toBe('atlas');
    expect(r.stdout).toContain('atlas');
  });

  test('several words make one name', () => {
    run(['quill', 'studio']);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).name).toBe('quill studio');
  });

  test('with no argument, prints the name and where it came from', () => {
    expect(run([]).stdout).toMatch(/^laptop-1234 \(the hostname/);
    run(['atlas']);
    expect(run([]).stdout).toMatch(/^atlas \(from .*config\.json\)/);
    expect(run([], { BUILDD_RUNNER_NAME: 'birch' }).stdout).toMatch(/^birch \(from BUILDD_RUNNER_NAME\)/);
  });

  test('saving while BUILDD_RUNNER_NAME is set warns that the env var still wins', () => {
    const r = run(['atlas'], { BUILDD_RUNNER_NAME: 'birch' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('BUILDD_RUNNER_NAME');
  });

  test('--clear goes back to the hostname', () => {
    run(['atlas']);
    expect(run(['--clear']).code).toBe(0);
    expect(run([]).stdout).toMatch(/^laptop-1234 \(the hostname/);
  });

  test('a name with nothing printable is refused and nothing is written', () => {
    const r = run(['\u0007']);
    expect(r.code).not.toBe(0);
    expect(existsSync(configFile)).toBe(false);
  });
});

describe('heartbeat label', () => {
  test('no name label while the runner goes by its hostname', () => {
    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'laptop-1234' })).toBeNull();
  });

  test('a set name is sent', () => {
    writeFileSync(configFile, JSON.stringify({ name: 'atlas' }));
    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'laptop-1234' })).toBe('atlas');
  });

  test('withRunnerName adds the label and keeps the rest of the environment', () => {
    const env = { tools: [], envKeys: [], mcp: [], labels: { type: 'local', hostname: 'laptop-1234' }, scannedAt: 'x' };
    expect(withRunnerName(env, 'atlas')).toEqual({ ...env, labels: { type: 'local', hostname: 'laptop-1234', name: 'atlas' } });
    expect(withRunnerName(env, null)).toBe(env);
    expect(withRunnerName(undefined, 'atlas')).toBeUndefined();
  });
});
