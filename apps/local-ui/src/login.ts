#!/usr/bin/env bun

import { parseArgs } from 'util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.buildd');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CLAUDE_JSON = join(homedir(), '.claude.json');
const MCP_SERVER_PATH = join(CONFIG_DIR, 'apps', 'mcp-server', 'src', 'index.ts');

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
  },
});

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
  mkdirSync(CONFIG_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_FILE)) {
      existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  const merged = { ...existing, ...data };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

function configureMcp() {
  if (values['no-mcp']) return;

  // Only configure MCP if the server script exists (i.e., installed via install.sh)
  if (!existsSync(MCP_SERVER_PATH)) {
    console.log('MCP server not found at ~/.buildd/apps/mcp-server — skipping MCP config');
    return;
  }

  try {
    let config: Record<string, unknown> = {};
    if (existsSync(CLAUDE_JSON)) {
      config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    (config.mcpServers as Record<string, unknown>).buildd = {
      command: 'bun',
      args: ['run', MCP_SERVER_PATH],
    };

    writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2) + '\n');
    console.log(`MCP server configured in ${CLAUDE_JSON}`);
  } catch (err) {
    console.error('Failed to configure MCP:', err);
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
        body: JSON.stringify({ device_token: data.device_token }),
      });

      if (pollRes.status === 200) {
        const tokenData = await pollRes.json() as { api_key: string; email?: string; pusherKey?: string; pusherCluster?: string };
        const configData: Record<string, unknown> = { apiKey: tokenData.api_key, builddServer: serverUrl };
        if (tokenData.pusherKey) configData.pusherKey = tokenData.pusherKey;
        if (tokenData.pusherCluster) configData.pusherCluster = tokenData.pusherCluster;
        saveConfig(configData);
        configureMcp();

        console.log('');
        console.log(`Authenticated${tokenData.email ? ` as ${tokenData.email}` : ''}`);
        console.log(`API key saved to ${CONFIG_FILE}`);
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
        if (pusherKey) saveConfig({ pusherKey, pusherCluster });
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
  configureMcp();

  console.log('');
  console.log(`Authenticated${email ? ` as ${email}` : ''}`);
  console.log(`API key saved to ${CONFIG_FILE}`);
  if (!values['no-mcp'] && existsSync(MCP_SERVER_PATH)) {
    console.log(`MCP server configured in ${CLAUDE_JSON}`);
  }
  console.log('');
} catch (err: any) {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
} finally {
  tempServer.stop();
}
