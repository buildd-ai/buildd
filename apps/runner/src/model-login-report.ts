/**
 * The per-backend model-login lines `buildd --doctor` and `buildd status` print
 * (docs spec runner-model-login-detect-say-report, R-14 to R-18).
 *
 * Both read the one detector in host-seat.ts, so they say what startup and the
 * heartbeat say. Labels and the way a login was found only: no token, key or
 * file contents, and no model call (an expired login still reads as present).
 */
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  NO_CODEX_AUTH_FIX,
  NO_MODEL_AUTH_FIX,
  detectCodexAuthSource,
  detectModelAuthSource,
  type CodexAuthSource,
  type MachineLoginProbe,
  type ModelAuthSource,
} from './host-seat';

/** Words for a Claude label, shared by startup, doctor and status. */
export function claudeLoginWords(source: ModelAuthSource): string {
  switch (source) {
    case 'machine_token': return 'uses a Claude token set on this machine';
    case 'machine_login': return "uses this machine's Claude login";
    case 'api_key': return 'uses an API key (billed per token)';
    default: return `no model login on this machine. To fix: ${NO_MODEL_AUTH_FIX}`;
  }
}

/** Words for a Codex label. `none` is information, not a warning. */
export function codexLoginWords(source: CodexAuthSource): string {
  switch (source) {
    case 'machine_login': return "uses this machine's Codex login";
    case 'api_key': return 'uses an OpenAI API key (billed per token)';
    default: return `no Codex login on this machine (optional). To use Codex: ${NO_CODEX_AUTH_FIX}`;
  }
}

const CODEX_TARGET: Record<string, string | undefined> = {
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
  'android:x64': 'x86_64-unknown-linux-musl',
  'android:arm64': 'aarch64-unknown-linux-musl',
  'darwin:x64': 'x86_64-apple-darwin',
  'darwin:arm64': 'aarch64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
};

/**
 * The Codex binary the runner launches: `CODEX_PATH_OVERRIDE` when set (as
 * codex-backend.ts honours it), else the one bundled with @openai/codex-sdk,
 * found the way the SDK's own findCodexPath does. Never a `codex` on PATH.
 * Null when it is not on disk.
 */
export function resolveLaunchedCodexBinary(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const override = (env.CODEX_PATH_OVERRIDE ?? '').trim();
  if (override) return existsSync(override) ? override : null;
  const triple = CODEX_TARGET[`${platform}:${arch}`];
  if (!triple) return null;
  const osName = platform === 'android' ? 'linux' : platform;
  try {
    const sdk = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
    const codexPkg = createRequire(sdk).resolve('@openai/codex/package.json');
    const platformPkg = createRequire(codexPkg).resolve(`@openai/codex-${osName}-${arch}/package.json`);
    const root = join(dirname(platformPkg), 'vendor', triple);
    const name = platform === 'win32' ? 'codex.exe' : 'codex';
    // Current layout (bin/), then the legacy one (codex/), as the SDK checks.
    return [join(root, 'bin', name), join(root, 'codex', name)].find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}

export interface BackendLoginLine {
  backend: 'claude' | 'codex';
  label: ModelAuthSource | CodexAuthSource;
  /** "Claude: uses this machine's Claude login" */
  text: string;
}

/** One line per backend, Claude then Codex: the words doctor and status share. */
export function backendLoginLines(probe: MachineLoginProbe = {}): BackendLoginLine[] {
  const claude = detectModelAuthSource(probe).source;
  const codex = detectCodexAuthSource({ env: probe.env, home: probe.home });
  return [
    { backend: 'claude', label: claude, text: `Claude: ${claudeLoginWords(claude)}` },
    { backend: 'codex', label: codex, text: `Codex: ${codexLoginWords(codex)}` },
  ];
}
