/**
 * Peer install specs for the consumer smoke test, pinned to the versions the
 * monorepo already resolved.
 *
 * Installing a bare range (`ai@^7.0.0`) asks npm for whatever is newest right
 * now. That flaked: npm picked a version published seconds earlier whose
 * tarball was not fetchable yet (ETARGET). The smoke test is about whether the
 * kit installs and loads, not about the registry's last minute, so each peer
 * is installed at the exact version in the root `bun.lock` -- the same one the
 * kit is built and unit-tested against -- and falls back to the declared range
 * only when the lockfile has no usable entry.
 *
 * Plain ESM with no dependencies: the smoke test runs under node in a project
 * outside the monorepo.
 */

const PKG_NAME = '@builddai/ai-kit';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The version bun.lock resolved for `name`, preferring an entry nested under
 * the kit (a copy only the kit sees) over the hoisted one. Null when absent.
 *
 * Reads lines rather than parsing: bun.lock is JSONC with trailing commas.
 */
export function lockedVersion(lockText, name, owner = PKG_NAME) {
  for (const key of [`${owner}/${name}`, name]) {
    const m = lockText.match(new RegExp(`^\\s*"${escape(key)}": \\["${escape(name)}@([^"]+)"`, 'm'));
    if (m) return m[1];
  }
  return null;
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(v);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' } : null;
};
const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * Whether `version` satisfies `range`, for the range shapes peer ranges use
 * here: exact, `^x.y.z`, `~x.y.z`. Null for anything else (unknown, so the
 * caller does not trust the pin). A prerelease never satisfies.
 */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v || v.pre) return v ? false : null;
  const r = range.trim();
  const exact = parse(r);
  if (exact) return cmp(v, exact) === 0;
  const m = /^([\^~])(.+)$/.exec(r);
  const base = m && parse(m[2]);
  if (!base || base.pre) return null;
  if (cmp(v, base) < 0) return false;
  if (m[1] === '~') return v.major === base.major && v.minor === base.minor;
  if (base.major > 0) return v.major === base.major;
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
  return cmp(v, base) === 0;
}

/**
 * `name@version` for every peer the lockfile pins inside its declared range,
 * `name@range` otherwise, with a line saying which and why.
 */
export function pinnedPeerSpecs(peers, lockText) {
  return Object.entries(peers).map(([name, range]) => {
    const locked = lockText ? lockedVersion(lockText, name) : null;
    if (locked && satisfies(locked, range) === true) {
      return { spec: `${name}@${locked}`, note: `${name}: ${locked} (bun.lock, declared ${range})` };
    }
    const why = !lockText ? 'no bun.lock' : !locked ? 'not in bun.lock' : `bun.lock has ${locked}, outside ${range}`;
    return { spec: `${name}@${range}`, note: `${name}: ${range} (${why}; npm resolves the range)` };
  });
}

/**
 * Errors worth one retry: the registry not having (or not yet serving) a
 * version, and the network. Anything else -- a bad tarball, a peer conflict --
 * fails the same way twice and is reported as-is.
 */
export function isRetryableNpmError(text) {
  return /\b(ETARGET|ENOTFOUND|E404|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|ESOCKETTIMEDOUT)\b|network|socket hang up/i.test(String(text));
}
