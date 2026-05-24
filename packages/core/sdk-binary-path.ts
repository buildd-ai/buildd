import { createRequire } from 'module';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const req = createRequire(import.meta.url);

let cached: string | null | undefined;

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
      // Both variants may be installed; prefer musl since that's what the SDK
      // tends to pick on Alpine-derived/musl Bun runtimes.
      candidates.push(
        `claude-agent-sdk-linux-${arch}-musl`,
        `claude-agent-sdk-linux-${arch}`,
      );
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
