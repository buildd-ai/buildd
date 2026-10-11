/**
 * `buildd-once --upload-warm`: the warm snapshot upload a lease container's
 * last run deferred (warm-repo.ts defer), exec'd by the cloud agent just
 * before it destroys the container (apps/cloud-runner container-lease.ts).
 * Nothing recorded, or warm repos off: exits 0 having done nothing. Prints
 * the usual phase and metric lines; the last line is BUILDD_WARM_UPLOAD_DONE
 * with `uploaded` or `none`.
 */
import { join } from 'path';
import { resolveBuilddHome } from './buildd-home';
import { createWarmRepoSession, warmRepoEnabled } from './warm-repo';

export const WARM_UPLOAD_DONE_PREFIX = 'BUILDD_WARM_UPLOAD_DONE=';

const env = process.env as Record<string, string | undefined>;
let uploaded = false;
if (env.BUILDD_EXECUTOR === 'cloud' && warmRepoEnabled(env)) {
  const session = createWarmRepoSession({ ...env, BUILDD_WARM_UPLOAD_DEFER: undefined }, join(resolveBuilddHome({ env }), 'warm-tmp'));
  uploaded = await session.uploadDeferred();
}
console.log(`${WARM_UPLOAD_DONE_PREFIX}${uploaded ? 'uploaded' : 'none'}`);
process.exit(0);
