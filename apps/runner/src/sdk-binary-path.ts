import { createRequire } from 'module';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

const req = createRequire(import.meta.url);

let cached: string | null | undefined;
let cachedCliVersion: string | null | undefined;

/**
 * Resolve the Claude Code native binary shipped by @anthropic-ai/claude-agent-sdk's
 * platform-specific optional dependency.
 *
 * Why this exists: under Bun's isolated linker the SDK's own resolver fails to
 * locate the platform variant ("Claude Code native binary not found at ..."),
 * even though the file is on disk. We resolve via the parent SDK package — a
 * direct dependency, which works in both isolated and hoisted layouts — then
 * walk to its @anthropic-ai/ scope dir where the platform variant lives as a
 * sibling (real dir in hoisted, symlink in Bun isolated).
 *
 * Returns undefined if resolution fails; pass that to query() and the SDK will
 * fall back to its own (sometimes-working) resolver.
 */
export function resolveClaudeBinaryPath(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;

  try {
    const sdkPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const scopeDir = dirname(dirname(sdkPkgJson)); // .../@anthropic-ai/

    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';

    const candidates: string[] = [];
    if (platform === 'linux') {
      // Prefer the variant that matches the system's libc. musl systems have
      // /lib/ld-musl-* as the dynamic linker; glibc systems (Ubuntu, Debian,
      // GitHub Actions) do not. Using the wrong variant fails at exec time with
      // "cannot execute: required file not found".
      const isMusl = existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
      if (isMusl) {
        candidates.push(
          `claude-agent-sdk-linux-${arch}-musl`,
          `claude-agent-sdk-linux-${arch}`,
        );
      } else {
        candidates.push(
          `claude-agent-sdk-linux-${arch}`,
          `claude-agent-sdk-linux-${arch}-musl`,
        );
      }
    } else if (platform === 'darwin') {
      candidates.push(`claude-agent-sdk-darwin-${arch}`);
    } else if (platform === 'win32') {
      candidates.push(`claude-agent-sdk-win32-${arch}`);
    }

    for (const pkgName of candidates) {
      const binaryPath = join(scopeDir, pkgName, binaryName);
      if (existsSync(binaryPath)) {
        cached = binaryPath;
        return binaryPath;
      }
    }
  } catch {
    // require.resolve failed or fs check threw — fall through to undefined
  }

  cached = null;
  return undefined;
}

/**
 * Read the Claude Code CLI version bundled by the installed
 * @anthropic-ai/claude-agent-sdk, from the package's own manifest.json — not
 * inferred from the SDK's npm version. They move in lockstep on the patch
 * number today, but this reads the value the API's own version-gate error
 * names, so a claim-time capability check compares against ground truth.
 *
 * `manifest.json` isn't in the package's `exports` map, so it can't be
 * resolved directly — resolve `package.json` (which Node/Bun always permit)
 * and read the sibling file from that directory, same trick as the binary
 * resolution above.
 *
 * Returns undefined if resolution fails (e.g. a future SDK layout change) —
 * callers must treat an unknown version as "don't block", not "too old".
 */
export function resolveClaudeCliVersion(): string | undefined {
  if (cachedCliVersion !== undefined) return cachedCliVersion ?? undefined;

  try {
    const sdkPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const manifestPath = join(dirname(sdkPkgJson), 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    if (typeof manifest.version === 'string' && manifest.version) {
      cachedCliVersion = manifest.version;
      return cachedCliVersion;
    }
  } catch {
    // require.resolve failed, file missing, or bad JSON — fall through to undefined
  }

  cachedCliVersion = null;
  return undefined;
}
