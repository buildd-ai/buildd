/**
 * One-time backfill: stamp mergedAt / prLifecycleStatus on workers where
 * prNumber IS NOT NULL AND mergedAt IS NULL by querying GitHub.
 *
 * Usage:
 *   DATABASE_URL=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY_BASE64=... \
 *     bun packages/core/scripts/backfill-mergedat.ts [--dry-run]
 *
 * --dry-run  Print what would change without writing to the DB.
 *
 * Workers with prUrl are cross-checked against the GitHub Pulls API.
 *   merged     → stamps mergedAt (GitHub merged_at) + prLifecycleStatus='merged'
 *   closed     → sets prLifecycleStatus='closed'
 *   open       → untouched
 * No GitHub installation → skipped (workspace not linked).
 */

import { db } from '../db/index';
import { workers, workspaces, githubInstallations } from '../db/schema';
import { and, isNull, isNotNull, eq } from 'drizzle-orm';
import { createSign, createPrivateKey } from 'crypto';

// ─── Minimal inline GitHub auth ──────────────────────────────────────────────

function getPrivateKey(): string | undefined {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (b64) return Buffer.from(b64, 'base64').toString('utf-8');
  return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signing = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  return `${signing}.${b64url(signer.sign(createPrivateKey(privateKey)))}`;
}

async function getToken(appId: string, privateKey: string, installationId: number): Promise<string> {
  // Use cached token if fresh enough
  const inst = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
    columns: { accessToken: true, tokenExpiresAt: true },
  });
  if (inst?.accessToken && inst.tokenExpiresAt) {
    if (new Date(inst.tokenExpiresAt) > new Date(Date.now() + 5 * 60 * 1000)) {
      return inst.accessToken;
    }
  }

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${makeJwt(appId, privateKey)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { token: string };
  return data.token;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const APP_ID = process.env.GITHUB_APP_ID;
  const PRIVATE_KEY = getPrivateKey();
  if (!APP_ID || !PRIVATE_KEY) {
    console.error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64 (or GITHUB_APP_PRIVATE_KEY) are required');
    process.exit(1);
  }

  const candidates = await db.query.workers.findMany({
    where: and(isNotNull(workers.prNumber), isNull(workers.mergedAt), isNotNull(workers.prUrl)),
    columns: { id: true, prNumber: true, workspaceId: true },
  });

  console.log(`Found ${candidates.length} worker(s) with prNumber && !mergedAt${DRY_RUN ? ' [DRY RUN]' : ''}`);
  if (candidates.length === 0) return;

  // Group by workspace so we mint one token per workspace
  const byWs = new Map<string, typeof candidates>();
  for (const w of candidates) {
    if (!byWs.has(w.workspaceId)) byWs.set(w.workspaceId, []);
    byWs.get(w.workspaceId)!.push(w);
  }

  const counts = { stamped: 0, closed: 0, open: 0, skipped: 0 };

  for (const [wsId, wsWorkers] of byWs) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, wsId),
      columns: { repo: true },
      with: { githubInstallation: { columns: { installationId: true } } },
    });

    if (!ws?.repo || !ws.githubInstallation?.installationId) {
      console.log(`  workspace ${wsId}: no GitHub installation — skipping ${wsWorkers.length}`);
      counts.skipped += wsWorkers.length;
      continue;
    }

    const { repo } = ws;
    const { installationId } = ws.githubInstallation;
    console.log(`workspace ${wsId} (${repo}): ${wsWorkers.length} PR(s) to check`);

    let token: string;
    try {
      token = await getToken(APP_ID, PRIVATE_KEY, installationId);
    } catch (err) {
      console.error(`  token error:`, err);
      counts.skipped += wsWorkers.length;
      continue;
    }

    for (const worker of wsWorkers) {
      await new Promise(r => setTimeout(r, 200)); // 200ms rate-limit gap

      try {
        const prResp = await fetch(
          `https://api.github.com/repos/${repo}/pulls/${worker.prNumber}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        if (!prResp.ok) {
          console.log(`  PR #${worker.prNumber}: HTTP ${prResp.status} — skipping`);
          counts.skipped++;
          continue;
        }

        const pr = await prResp.json() as { state: string; merged: boolean; merged_at: string | null };

        if (pr.merged && pr.merged_at) {
          if (!DRY_RUN) {
            await db.update(workers)
              .set({ mergedAt: new Date(pr.merged_at), prLifecycleStatus: 'merged', updatedAt: new Date() })
              .where(eq(workers.id, worker.id));
          }
          console.log(`  PR #${worker.prNumber}: merged at ${pr.merged_at}${DRY_RUN ? ' [dry]' : ' ✓'}`);
          counts.stamped++;
        } else if (pr.state === 'closed') {
          if (!DRY_RUN) {
            await db.update(workers)
              .set({ prLifecycleStatus: 'closed', updatedAt: new Date() })
              .where(eq(workers.id, worker.id));
          }
          console.log(`  PR #${worker.prNumber}: closed (no merge)${DRY_RUN ? ' [dry]' : ' ✓'}`);
          counts.closed++;
        } else {
          console.log(`  PR #${worker.prNumber}: still open — skip`);
          counts.open++;
        }
      } catch (err) {
        console.error(`  PR #${worker.prNumber}: error:`, err);
        counts.skipped++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  stamped mergedAt : ${counts.stamped}`);
  console.log(`  marked closed    : ${counts.closed}`);
  console.log(`  still open       : ${counts.open}`);
  console.log(`  skipped/error    : ${counts.skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
