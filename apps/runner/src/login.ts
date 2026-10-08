#!/usr/bin/env bun

import { parseArgs } from 'util';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { writeSecretJsonFile } from './secure-file';
import { refreshBuilddMcpEntries } from './claude-json-mcp';

const CONFIG_DIR = join(homedir(), '.buildd');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CLAUDE_JSON = join(homedir(), '.claude.json');

// Parse CLI flags
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    server: {
      type: 'string',
      default: '',
    },
    name: {
      type: 'string',
      default: '',
    },
    level: {
      type: 'string',
      default: 'admin',
    },
    'no-mcp': {
      type: 'boolean',
      default: false,
    },
    device: {
      type: 'boolean',
      default: false,
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
  },
});

if (values.help) {
  console.log([
    'Usage: buildd login [--device] [--server <url>] [--name <key name>] [--no-mcp]',
    '',
    "Sign in and save an API key (and this machine's session presence token) to ~/.buildd/config.json.",
    '  --device        Sign in on another device with a code (no browser on this machine)',
    '  --server <url>  buildd server (default: the saved one, else https://buildd.dev)',
    '  --name <name>   Name for the new API key',
    '  --no-mcp        Do not update the buildd MCP entries in ~/.claude.json',
  ].join('\n'));
  process.exit(0);
}

// Load existing config
function loadConfig(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(data: Record<string, unknown>) {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_FILE)) {
      existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  const merged = { ...existing, ...data };
  // config.json holds a plaintext bld_* API key -- 0600, like codex-auth.ts and
  // claude-auth.ts do for their own credential files.
  writeSecretJsonFile(CONFIG_FILE, merged);
}

/**
 * The person's presence token for the agent plugin's hooks (one per machine,
 * labelled with this hostname). Only a well-formed one is kept; a login that
 * returns none clears an old one, which may belong to another server.
 */
function presenceTokenOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('bldp_') ? value : undefined;
}

function configureMcp(apiKey: string, server: string) {
  if (values['no-mcp']) return;

  try {
    // Re-key what `buildd install` set up; never add a user-wide entry, so the
    // workspace-folder scope survives a new login.
    const n = refreshBuilddMcpEntries(CLAUDE_JSON, apiKey, server);
    console.log(n > 0
      ? `Updated the key in ${n} buildd MCP entr${n === 1 ? 'y' : 'ies'} in ${CLAUDE_JSON}.`
      : 'To use buildd from Claude Code in your workspace folders, run: buildd install --global');
  } catch (err) {
    console.error('Failed to update the buildd MCP entries:', err);
  }
}

// Resolve server URL
const existingConfig = loadConfig();
const serverUrl = values.server
  || (existingConfig.builddServer as string)
  || 'https://buildd.dev';

// ============================================================================
// Device code flow
// ============================================================================
if (values.device) {
  console.log('Requesting device code...');

  try {
    const res = await fetch(`${serverUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: values.name || 'CLI',
        level: values.level || 'admin',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Failed to get device code: ${err}`);
      process.exit(1);
    }

    const data = await res.json() as {
      user_code: string;
      device_token: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    };

    console.log('');
    console.log('  Enter this code in your browser:');
    console.log('');
    console.log(`    ${data.user_code}`);
    console.log('');
    console.log(`  Open: ${data.verification_url}`);
    console.log('');
    console.log(`  Code expires in ${Math.floor(data.expires_in / 60)} minutes.`);
    console.log('  Waiting for approval...');

    // Poll for token
    const interval = (data.interval || 5) * 1000;
    const deadline = Date.now() + data.expires_in * 1000;

    while (Date.now() < deadline) {
      await Bun.sleep(interval);

      const pollRes = await fetch(`${serverUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_token: data.device_token, machine: hostname() }),
      });

      if (pollRes.status === 200) {
        const tokenData = await pollRes.json() as { api_key: string; presence_token?: string; email?: string; pusherKey?: string; pusherCluster?: string; pusherChannelPrefix?: string };
        const configData: Record<string, unknown> = { apiKey: tokenData.api_key, presenceToken: presenceTokenOf(tokenData.presence_token), builddServer: serverUrl };
        if (tokenData.pusherKey) configData.pusherKey = tokenData.pusherKey;
        if (tokenData.pusherCluster) configData.pusherCluster = tokenData.pusherCluster;
        if (tokenData.pusherChannelPrefix) configData.pusherChannelPrefix = tokenData.pusherChannelPrefix;
        saveConfig(configData);
        configureMcp(tokenData.api_key, serverUrl);

        console.log('');
        console.log(`Authenticated${tokenData.email ? ` as ${tokenData.email}` : ''}`);
        console.log(`API key saved to ${CONFIG_FILE}`);
        if (configData.presenceToken) console.log('Session presence token saved (used only by the buildd install hooks).');
        process.exit(0);
      } else if (pollRes.status === 428) {
        // Still pending — keep polling
        continue;
      } else {
        const err = await pollRes.text();
        console.error(`\nDevice code flow failed: ${err}`);
        process.exit(1);
      }
    }

    console.error('\nDevice code expired. Run `buildd login --device` to try again.');
    process.exit(1);
  } catch (err) {
    console.error('Device code flow error:', err);
    process.exit(1);
  }
}

// ============================================================================
// Browser OAuth flow (default)
// ============================================================================
console.log('Starting login flow...');

// Start a temporary local server to receive the callback
let resolveCallback: (token: string, email: string) => void;
let rejectCallback: (error: string) => void;

const callbackPromise = new Promise<{ token: string; email: string }>((resolve, reject) => {
  resolveCallback = (token, email) => resolve({ token, email });
  rejectCallback = (error) => reject(new Error(error));
});

const tempServer = Bun.serve({
  port: 0, // Random available port
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/callback') {
      const token = url.searchParams.get('token');
      const error = url.searchParams.get('error');
      const email = url.searchParams.get('email') || '';

      if (error) {
        rejectCallback(error);
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head><title>Login Failed</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center; background: #1a1b26; color: #fff;">
            <h1>Login Failed</h1>
            <p style="color: #f87171;">${error}</p>
            <p>You can close this tab.</p>
          </body>
          </html>
        `, { headers: { 'Content-Type': 'text/html' } });
      }

      if (token && token.startsWith('bld_')) {
        const pusherKey = url.searchParams.get('pusherKey') || '';
        const pusherCluster = url.searchParams.get('pusherCluster') || '';
        const pusherChannelPrefix = url.searchParams.get('pusherChannelPrefix') || '';
        if (pusherKey) saveConfig({ pusherKey, pusherCluster, ...(pusherChannelPrefix && { pusherChannelPrefix }) });
        saveConfig({ presenceToken: presenceTokenOf(url.searchParams.get('presenceToken')) });
        resolveCallback!(token, email);
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head><title>Login Success</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center; background: #1a1b26; color: #fff;">
            <h1 style="color: #4ade80;">Logged in!</h1>
            <p>You can close this tab and return to the terminal.</p>
          </body>
          </html>
        `, { headers: { 'Content-Type': 'text/html' } });
      }

      rejectCallback('No valid token received');
      return new Response('Invalid callback', { status: 400 });
    }

    return new Response('Not found', { status: 404 });
  },
});

const callbackUrl = `http://localhost:${tempServer.port}/callback`;

// Build the auth URL
const authParams = new URLSearchParams();
authParams.set('callback', callbackUrl);
authParams.set('client', 'cli');
authParams.set('machine', hostname());
if (values.name) authParams.set('account_name', values.name);
if (values.level) authParams.set('level', values.level);

const authUrl = `${serverUrl}/api/auth/cli?${authParams.toString()}`;

// Open browser
console.log(`Opening browser to ${serverUrl}...`);

const proc = Bun.spawn(['open', authUrl], { stdio: ['ignore', 'ignore', 'ignore'] });
await proc.exited;

console.log('Waiting for authentication...');

try {
  const { token, email } = await callbackPromise;

  // Save config
  saveConfig({ apiKey: token, builddServer: serverUrl });

  // Configure MCP
  configureMcp(token, serverUrl);

  console.log('');
  console.log(`Authenticated${email ? ` as ${email}` : ''}`);
  console.log(`API key saved to ${CONFIG_FILE}`);
  console.log('');
} catch (err: any) {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
} finally {
  tempServer.stop();
}
