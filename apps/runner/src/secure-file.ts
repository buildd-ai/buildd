// Namespace imports: many runner tests mock.module('fs') with a partial stub.
import * as fs from 'fs';
import { dirname, join, resolve } from 'path';

/** Owner-only file mode for anything holding a credential. */
export const SECRET_FILE_MODE = 0o600;
/** Owner-only directory mode for anything containing a credential file. */
export const SECRET_DIR_MODE = 0o700;

// ── Owner-only on Windows ───────────────────────────────────────────────────
//
// On Windows chmod and writeFileSync({ mode }) do nothing to who can read a
// file: the DACL decides, and a new file inherits its directory's. Under the
// profile that is the owner, SYSTEM and Administrators, but a BUILDD_HOME (or
// any other path) outside it inherits what its drive gives, and C:\ gives
// Authenticated Users Modify on new folders. So on Windows every secret the
// runner writes also gets an explicit owner-only DACL.
//
// Limit: /inheritance:r drops inherited entries and /grant:r replaces the
// owner's; an entry someone added explicitly to a pre-existing path is kept.
// Paths the runner creates have none.

const SID_RE = /^S-1-\d+(-\d+)+$/;

/** The SID from `whoami /user /fo csv /nh` ("host\name","S-1-5-21-…"), or null. */
export function parseWhoamiSid(output: string): string | null {
  const fields = output.trim().split(',').map(f => f.trim().replace(/^"|"$/g, ''));
  const sid = fields[fields.length - 1] ?? '';
  return SID_RE.test(sid) ? sid : null;
}

/**
 * System32 by full path: on PATH, `whoami` is often Git for Windows' MSYS one,
 * which has no /user, and a PATH entry must not pick what sets the ACL.
 */
function system32(exe: string): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
}

// Bun.spawnSync, not child_process: several runner tests mock child_process.
function spawnText(argv: string[]): { exitCode: number; output: string; stdout: string } {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', windowsHide: true } as Parameters<typeof Bun.spawnSync>[1]);
    const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : '';
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
    return { exitCode: r.exitCode ?? -1, output: `${stdout}${stderr}`.trim(), stdout };
  } catch (err) {
    return { exitCode: -1, output: (err as Error).message, stdout: '' };
  }
}

let cachedSid: string | null | undefined;
function currentUserSid(): string | null {
  if (cachedSid === undefined) {
    const r = spawnText([system32('whoami.exe'), '/user', '/fo', 'csv', '/nh']);
    cachedSid = r.exitCode === 0 ? parseWhoamiSid(r.stdout) : null;
  }
  return cachedSid;
}

/**
 * Drop the inherited entries and grant the owner alone: the Windows 0600.
 * `inherit` (directories) makes the grant inherit to files and subdirectories,
 * so what is created or renamed in later is owner-only too: the Windows 0700.
 */
export function ownerOnlyAclCommand(path: string, sid: string, opts: { inherit?: boolean } = {}): string[] {
  return ['icacls', path, '/inheritance:r', '/grant:r', `*${sid}:${opts.inherit ? '(OI)(CI)(F)' : '(F)'}`];
}

function runCommand(argv: string[]): { exitCode: number; output: string } {
  const r = spawnText([argv[0] === 'icacls' ? system32('icacls.exe') : argv[0], ...argv.slice(1)]);
  return { exitCode: r.exitCode, output: r.output };
}

export interface OwnerAclDeps {
  platform?: NodeJS.Platform;
  run?: (argv: string[]) => { exitCode: number; output: string };
  sid?: () => string | null;
}

/**
 * Windows: replace `path`'s DACL with one entry for the current user (with
 * `directory`, one that children inherit). Throws when that fails. Elsewhere a
 * no-op that returns false: POSIX callers keep their chmod.
 */
export function restrictToOwnerAcl(path: string, opts: OwnerAclDeps & { directory?: boolean } = {}): boolean {
  if ((opts.platform ?? process.platform) !== 'win32') return false;
  const sid = (opts.sid ?? currentUserSid)();
  if (!sid) throw new Error(`cannot restrict ${path} to its owner: no SID for the current user (whoami /user)`);
  const r = (opts.run ?? runCommand)(ownerOnlyAclCommand(path, sid, { inherit: opts.directory }));
  if (r.exitCode !== 0) {
    throw new Error(`cannot restrict ${path} to its owner: icacls exited ${r.exitCode}${r.output ? `: ${r.output}` : ''}`);
  }
  return true;
}

const restrictedDirs = new Set<string>();

function dirCacheKey(dir: string): string {
  // The creation time keys a directory removed and made again at the same path.
  let born = '';
  try { born = String(fs.statSync(dir).birthtimeMs); } catch { /* path alone */ }
  return `${resolve(dir).toLowerCase()}|${born}`;
}

/**
 * Windows: make `dir` owner-only, inheritably, once per directory per process,
 * so a token refresh that rewrites a file in it does not spawn icacls again.
 * Throws when that fails. Elsewhere a no-op that returns false.
 */
export function restrictDirToOwnerOnce(dir: string, opts: OwnerAclDeps = {}): boolean {
  if ((opts.platform ?? process.platform) !== 'win32') return false;
  const key = dirCacheKey(dir);
  if (restrictedDirs.has(key)) return true;
  restrictToOwnerAcl(dir, { ...opts, directory: true });
  restrictedDirs.add(key);
  return true;
}

/** Tests only: forget which directories were restricted. */
export function _resetOwnerAclCache(): void {
  restrictedDirs.clear();
}

const warned = new Set<string>();

/**
 * Best-effort form, for the spots where POSIX ignores a failed chmod: a failure
 * is logged once per path and the caller carries on.
 */
export function tryRestrictToOwnerAcl(
  path: string,
  opts: OwnerAclDeps & { directory?: boolean; warn?: (msg: string) => void } = {},
): boolean {
  try {
    return opts.directory ? restrictDirToOwnerOnce(path, opts) : restrictToOwnerAcl(path, opts);
  } catch (err) {
    if (!warned.has(path)) {
      warned.add(path);
      (opts.warn ?? console.warn)(`[buildd] ${(err as Error).message}`);
    }
    return false;
  }
}

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
 * leaving an API key world-readable. Windows gets the same two steps as ACLs.
 */
export function writeSecretJsonFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  // Best-effort: the dir may have pre-existed with a looser mode.
  try { fs.chmodSync(dir, SECRET_DIR_MODE); } catch { /* not fatal */ }
  tryRestrictToOwnerAcl(dir, { directory: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  fs.chmodSync(filePath, SECRET_FILE_MODE);
  restrictToOwnerAcl(filePath);
}
