/**
 * verify-redis-prod.ts
 *
 * Confirms that PRODUCTION is actually writing to the Upstash Redis DB.
 *
 * Why this exists: apps/web/src/lib/redis.ts degrades gracefully to a no-op
 * when UPSTASH_REDIS_REST_URL/TOKEN are unset — so a misconfigured prod looks
 * identical to a healthy one (no errors, no traffic). Upstash then flags the DB
 * inactive. This script proves the opposite: prod is issuing SET/GET commands.
 *
 * IMPORTANT: Vercel bakes env vars at deploy time. Setting the var only takes
 * effect on the NEXT production deploy. Run this AFTER that deploy is READY.
 *
 * Usage:
 *   # 1. Confirm the deploy that carries the env var is actually live (see memory:
 *   #    /api/version lies — check Vercel deployment state, not the version route).
 *   # 2. Run against prod with a real API key:
 *   BUILDD_API_KEY=bld_xxx PROD_URL=https://buildd.dev \
 *     bun apps/web/scripts/verify-redis-prod.ts
 *
 * Reads Upstash creds from apps/web/.env (UPSTASH_REDIS_REST_URL/TOKEN or
 * KV_REST_API_URL/TOKEN — same fallback order as lib/redis.ts).
 */
import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const raw = readFileSync(join(import.meta.dir, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in out) || !out[m[1]]) out[m[1]] = v;
    }
  } catch {
    // .env optional if vars already in process.env
  }
  return out;
}

const env = loadEnv();
const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('❌ No Upstash creds found in env or apps/web/.env');
  console.error('   Expected UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN.');
  process.exit(1);
}

const redis = new Redis({ url, token });
const PROD_URL = env.PROD_URL || 'https://buildd.dev';
const API_KEY = env.BUILDD_API_KEY;

async function scanBuilddKeys(): Promise<{ key: string; ttl: number }[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'buildd:*', count: 100 });
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  const withTtl = await Promise.all(
    found.map(async k => ({ key: k, ttl: await redis.ttl(k) })),
  );
  return withTtl.sort((a, b) => a.key.localeCompare(b.key));
}

function fmt(rows: { key: string; ttl: number }[]) {
  if (rows.length === 0) return '   (none)';
  return rows.map(r => `   ${r.key}  ttl=${r.ttl}s`).join('\n');
}

async function main() {
  console.log(`🔌 Upstash: ${url}`);
  const dbsize = await redis.dbsize();
  console.log(`📦 DBSIZE = ${dbsize}`);

  console.log('\n— baseline buildd:* keys —');
  const before = await scanBuilddKeys();
  console.log(fmt(before));

  if (!API_KEY) {
    console.log(
      '\n⚠️  No BUILDD_API_KEY set — skipping the prod-write trigger.\n' +
        '   The scan above only proves keys EXIST, not that PROD wrote them.\n' +
        '   Re-run with BUILDD_API_KEY=bld_xxx to attribute a fresh write to prod.',
    );
    process.exit(before.length > 0 ? 0 : 2);
  }

  // Trigger a prod write: /api/workers/active (API-key auth) exercises
  // authenticateApiKey -> setCachedApiKey (buildd:api_key:{hash}),
  // getAccountWorkspacePermissions -> setCachedAccountWorkspaces, and
  // setCachedOpenWorkspaceIds -> buildd:open_workspaces.
  const hash = createHash('sha256').update(API_KEY).digest('hex');
  const apiKeyCacheKey = `buildd:api_key:${hash}`;

  // Clear our target key so a post-request hit is unambiguously a prod write.
  await redis.del(apiKeyCacheKey);
  console.log(`\n🧹 Cleared ${apiKeyCacheKey} to isolate the next prod write.`);

  console.log(`🌐 GET ${PROD_URL}/api/workers/active (Bearer bld_…)`);
  const res = await fetch(`${PROD_URL}/api/workers/active`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  console.log(`   → HTTP ${res.status}`);
  if (res.status === 401) {
    console.error('❌ 401 Unauthorized — API key rejected. Cache write not triggered.');
    process.exit(1);
  }

  // Small settle; the write is synchronous within the request, so it should
  // already be present, but allow for edge propagation.
  const ttl = await redis.ttl(apiKeyCacheKey);
  const exists = ttl !== -2; // -2 = missing, -1 = no expiry, >=0 = ttl

  console.log('\n— after prod request —');
  console.log(fmt(await scanBuilddKeys()));

  console.log('\n══════════════════════════════════════');
  if (exists) {
    console.log(`✅ PASS — prod wrote ${apiKeyCacheKey} (ttl=${ttl}s).`);
    console.log('   Production is actively sending traffic to Upstash. DB will stay active.');
    process.exit(0);
  } else {
    console.log(`❌ FAIL — ${apiKeyCacheKey} absent after a 2xx prod request.`);
    console.log('   Prod is NOT writing to Upstash. Likely causes:');
    console.log('   • Env var set in Vercel but prod not yet REDEPLOYED (vars bake at deploy time)');
    console.log('   • Var scoped to wrong environment (Preview vs Production)');
    console.log('   • Wrong var name — lib/redis.ts reads KV_REST_API_* or UPSTASH_REDIS_REST_*');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Error:', e?.message || e);
  process.exit(1);
});
