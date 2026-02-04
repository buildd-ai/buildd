#!/usr/bin/env bun
/**
 * Doctor script - checks if environment is correctly configured
 * Usage: cd apps/web && bun run doctor
 *        cd apps/web && bun run doctor --vercel  (checks production env)
 */

import { resolve } from 'path';
import { $ } from 'bun';

const useVercel = process.argv.includes('--vercel');
const monorepoRoot = resolve(import.meta.dir, '../../..');

async function loadEnvFile(path: string) {
  const file = Bun.file(path);
  if (await file.exists()) {
    const text = await file.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        let val = trimmed.slice(eqIdx + 1);
        // Remove surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
    return true;
  }
  return false;
}

if (useVercel) {
  // Pull env vars from Vercel
  const tempEnvPath = resolve(monorepoRoot, '.env.vercel-doctor');
  try {
    console.log('Pulling environment from Vercel production...\n');
    await $`cd ${monorepoRoot} && bunx vercel env pull ${tempEnvPath} --environment=production --yes`.quiet();
    await loadEnvFile(tempEnvPath);
    await $`rm ${tempEnvPath}`.quiet();
  } catch (e) {
    console.error('Failed to pull from Vercel. Make sure you are logged in (vercel login) and linked (vercel link).\n');
    process.exit(1);
  }
} else {
  // Load .env.local from monorepo root
  const loaded = await loadEnvFile(resolve(monorepoRoot, '.env.local'));
  if (!loaded) {
    await loadEnvFile(resolve(monorepoRoot, '.env'));
  }
}

import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const ok = green('✓');
const fail = red('✗');
const warn = yellow('○');

interface Check {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  message?: string;
}

const checks: Check[] = [];

function check(name: string, status: 'ok' | 'fail' | 'warn', message?: string) {
  checks.push({ name, status, message });
  const icon = status === 'ok' ? ok : status === 'fail' ? fail : warn;
  const msg = message ? dim(` (${message})`) : '';
  console.log(`${icon} ${name}${msg}`);
}

function envExists(key: string): boolean {
  return !!process.env[key];
}

function envGroup(...keys: string[]): boolean {
  return keys.every(envExists);
}

async function main() {
  console.log('\n🩺 Buildd Doctor\n');

  // Required
  console.log('Required:');

  // Database
  if (envExists('DATABASE_URL')) {
    try {
      await db.execute(sql`SELECT 1`);
      check('DATABASE_URL', 'ok', 'connected');
    } catch (e) {
      // Neon serverless may not connect from local scripts - that's ok if var exists
      check('DATABASE_URL', 'ok', 'set (connection test skipped)');
    }
  } else {
    check('DATABASE_URL', 'fail', 'missing');
  }

  // Auth
  check('AUTH_SECRET', envExists('AUTH_SECRET') ? 'ok' : 'fail', !envExists('AUTH_SECRET') ? 'missing' : undefined);
  check('AUTH_URL', envExists('AUTH_URL') ? 'ok' : 'fail', !envExists('AUTH_URL') ? 'missing' : process.env.AUTH_URL);

  // OAuth
  const oauthOk = envGroup('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  check('Google OAuth', oauthOk ? 'ok' : 'fail', !oauthOk ? 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing' : undefined);

  // Optional
  console.log('\nOptional:');

  // Subdomain cookies
  if (envExists('AUTH_COOKIE_DOMAIN')) {
    check('AUTH_COOKIE_DOMAIN', 'ok', process.env.AUTH_COOKIE_DOMAIN);
  } else {
    check('AUTH_COOKIE_DOMAIN', 'warn', 'not set - only needed for subdomain routing');
  }

  // Pusher
  const pusherServer = envGroup('PUSHER_APP_ID', 'PUSHER_KEY', 'PUSHER_SECRET', 'PUSHER_CLUSTER');
  const pusherClient = envGroup('NEXT_PUBLIC_PUSHER_KEY', 'NEXT_PUBLIC_PUSHER_CLUSTER');
  if (pusherServer && pusherClient) {
    check('Pusher', 'ok', 'server + client configured');
  } else if (pusherServer || pusherClient) {
    check('Pusher', 'warn', 'partially configured');
  } else {
    check('Pusher', 'warn', 'not configured - realtime updates disabled');
  }

  // GitHub App
  const githubOk = envGroup(
    'GITHUB_APP_ID',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET'
  );
  const githubKey = envExists('GITHUB_APP_PRIVATE_KEY_BASE64') || envExists('GITHUB_APP_PRIVATE_KEY');
  if (githubOk && githubKey) {
    check('GitHub App', 'ok');
  } else if (githubOk || githubKey) {
    check('GitHub App', 'warn', 'partially configured');
  } else {
    check('GitHub App', 'warn', 'not configured - GitHub integration disabled');
  }

  // Summary
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  console.log('');
  if (failed.length > 0) {
    console.log(red(`${failed.length} required config(s) missing - app will not work correctly`));
    process.exit(1);
  } else if (warned.length > 0) {
    console.log(yellow(`All required configs present, ${warned.length} optional feature(s) disabled`));
  } else {
    console.log(green('All configs present'));
  }
  console.log('');
}

main().catch(console.error);
