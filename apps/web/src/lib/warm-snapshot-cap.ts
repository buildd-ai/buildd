/**
 * The per-workspace warm snapshot cap for the cloud runner (apps/cloud-runner,
 * apps/runner/src/warm-repo.ts): the largest repo bundle or (compressed)
 * dependency cache tarball one warm generation may hold.
 *
 * Set in `gitConfig.warmSnapshot.maxBytes`. Delivered to the dispatcher with
 * the run's GitHub grant (POST /api/runner/github-token), which hands it to
 * the container on `GET /warm/limits` and enforces it on upload. Unset or
 * malformed: null, and the dispatcher's own default (WARM_MAX_BUNDLE_BYTES,
 * 1 GiB unless set) applies.
 */

/** Upper bound buildd puts on any workspace's cap. Mirrors WARM_MAX_UPLOAD_BYTES in warm-repo.ts. */
export const WARM_SNAPSHOT_MAX_BYTES_CEILING = 8 * 1024 ** 3;

export function resolveWarmSnapshotMaxBytes(gitConfig: unknown): number | null {
  const warm = (gitConfig as { warmSnapshot?: unknown } | null | undefined)?.warmSnapshot;
  const n = (warm as { maxBytes?: unknown } | null | undefined)?.maxBytes;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
  return Math.min(n, WARM_SNAPSHOT_MAX_BYTES_CEILING);
}
