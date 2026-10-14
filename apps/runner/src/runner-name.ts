/**
 * `buildd name [<name>|--clear]`: a display name for this runner, so the
 * dashboard does not have to call it by an asset-tag hostname.
 *
 * Order: BUILDD_RUNNER_NAME, then `name` in ~/.buildd/config.json (BUILDD_HOME
 * and BUILDD_CONFIG respected, as index.ts reads them), then the hostname.
 *
 * The name goes out as `environment.labels.name` on every heartbeat and is
 * read fresh each time, so a rename shows without a restart. It is a label
 * only: the runner's identity (its localUiUrl, the heartbeat row's key) never
 * changes, so a renamed runner is the same row on the dashboard.
 */
import { existsSync, readFileSync } from 'fs';
import { hostname as osHostname } from 'os';
import { join } from 'path';
import { normalizeRunnerName, RUNNER_NAME_MAX_LENGTH, type WorkerEnvironment } from '@buildd/shared';
import { resolveBuilddHome } from './buildd-home';
import { writeSecretJsonFile } from './secure-file';

export type RunnerNameSource = 'env' | 'config' | 'hostname';

type Env = Record<string, string | undefined>;

export interface RunnerNameDeps {
  env?: Env;
  /** Defaults to runnerConfigFile(env). */
  configFile?: string;
  hostname?: string;
}

/** The runner's config file: BUILDD_CONFIG, else config.json under BUILDD_HOME. */
export function runnerConfigFile(env: Env = process.env): string {
  return env.BUILDD_CONFIG || join(resolveBuilddHome({ env }), 'config.json');
}

function readConfig(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveRunnerName(deps: RunnerNameDeps = {}): { name: string; source: RunnerNameSource } {
  const env = deps.env ?? process.env;
  const fromEnv = normalizeRunnerName(env.BUILDD_RUNNER_NAME);
  if (fromEnv) return { name: fromEnv, source: 'env' };
  const fromConfig = normalizeRunnerName(readConfig(deps.configFile ?? runnerConfigFile(env))?.name);
  if (fromConfig) return { name: fromConfig, source: 'config' };
  return { name: deps.hostname ?? osHostname(), source: 'hostname' };
}

/** config.json exists but is not a JSON object, so writing it would lose what it holds (the API key). */
export class UnreadableConfigError extends Error {
  constructor(readonly configFile: string) {
    super(`Cannot read ${configFile}: it is not a JSON object. Fix or move it and try again; it was not changed.`);
    this.name = 'UnreadableConfigError';
  }
}

/**
 * Write `name` into the config file (null removes it), keeping every other field.
 * Throws UnreadableConfigError, writing nothing, when the file exists but cannot be parsed.
 */
export function saveRunnerName(configFile: string, name: string | null): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    const existing = readConfig(configFile);
    if (!existing) throw new UnreadableConfigError(configFile);
    cfg = existing;
  }
  if (name === null) delete cfg.name;
  else cfg.name = name;
  // config.json holds the API key: owner-only, same as `buildd login` writes it.
  writeSecretJsonFile(configFile, cfg);
}

/**
 * The name to put on the heartbeat, or null while the runner goes by its
 * hostname (the dashboard already has that label). Never throws: a heartbeat
 * must not fail over a display name.
 */
export function heartbeatRunnerName(deps: RunnerNameDeps = {}): string | null {
  try {
    const r = resolveRunnerName(deps);
    return r.source === 'hostname' ? null : r.name;
  } catch {
    return null;
  }
}

/** The heartbeat environment with `labels.name` set; unchanged without a name or an environment. */
export function withRunnerName(environment: WorkerEnvironment | undefined, name: string | null): WorkerEnvironment | undefined {
  if (!environment || !name) return environment;
  return { ...environment, labels: { ...(environment.labels ?? {}), name } };
}

export interface NameCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `buildd name …`, given the words after `name`. */
export function runNameCommand(args: string[], deps: RunnerNameDeps = {}): NameCommandResult {
  const env = deps.env ?? process.env;
  const configFile = deps.configFile ?? runnerConfigFile(env);
  const resolveDeps = { ...deps, env, configFile };
  const envOverride = normalizeRunnerName(env.BUILDD_RUNNER_NAME);
  const envWarning = envOverride
    ? `BUILDD_RUNNER_NAME is set to "${envOverride}" in this environment, and it wins over the saved name while it is set.`
    : '';

  if (args.length === 0) {
    const { name, source } = resolveRunnerName(resolveDeps);
    const where = source === 'env'
      ? 'from BUILDD_RUNNER_NAME'
      : source === 'config'
        ? `from ${configFile}`
        : 'the hostname; set a name with: buildd name <name>';
    return { code: 0, stdout: `${name} (${where})`, stderr: '' };
  }

  const save = (value: string | null): NameCommandResult | null => {
    try {
      saveRunnerName(configFile, value);
      return null;
    } catch (err) {
      if (err instanceof UnreadableConfigError) return { code: 1, stdout: '', stderr: err.message };
      throw err;
    }
  };

  if (args.length === 1 && args[0] === '--clear') {
    const refused = save(null);
    if (refused) return refused;
    const { name } = resolveRunnerName(resolveDeps);
    return { code: 0, stdout: `Name removed. This runner shows as ${name} from its next heartbeat.`, stderr: envWarning };
  }

  const name = normalizeRunnerName(args.join(' '));
  if (!name) {
    return { code: 64, stdout: '', stderr: 'A runner name needs at least one letter or digit. Usage: buildd name <name>' };
  }
  const refused = save(name);
  if (refused) return refused;
  const cut = args.join(' ').trim().length > RUNNER_NAME_MAX_LENGTH ? ` (cut to ${RUNNER_NAME_MAX_LENGTH} characters)` : '';
  return {
    code: 0,
    stdout: `This runner is now named ${name}${cut}. The dashboard shows it from the runner's next heartbeat.`,
    stderr: envWarning,
  };
}
