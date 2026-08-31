import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';

/** Owner-only file mode for anything holding a credential. */
export const SECRET_FILE_MODE = 0o600;
/** Owner-only directory mode for anything containing a credential file. */
export const SECRET_DIR_MODE = 0o700;

/**
 * Write a credential-bearing JSON file so only the owner can read it.
 *
 * `~/.buildd/config.json` holds a plaintext `bld_*` API key but was written with
 * the process umask (commonly 0644 — world-readable), while the two sibling
 * credential writers, codex-auth.ts and claude-auth.ts, both chmod their
 * auth.json / .credentials.json to 0600. This closes that gap.
 *
 * Two details matter and are easy to get wrong:
 *
 *  - The chmod is unconditional, applied *after* the write. writeFileSync
 *    preserves the mode of a file that already exists, so a config.json created
 *    by an older runner would keep its wide mode forever if we only passed a
 *    `mode` on create.
 *  - No `mode` option on writeFileSync — codex-auth.ts documents a Bun 1.3.x bug
 *    where writeFileSync with `{ mode }` silently fails to create the file.
 *    Write first, chmod second.
 *
 * The directory chmod is best-effort (it may be a pre-existing shared path we
 * do not own); the file chmod is not, because failing loudly beats silently
 * leaving an API key world-readable.
 */
export function writeSecretJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: SECRET_DIR_MODE });
  // Best-effort: the dir may have pre-existed with a looser mode.
  try { chmodSync(dirname(filePath), SECRET_DIR_MODE); } catch { /* not fatal */ }
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  chmodSync(filePath, SECRET_FILE_MODE);
}
