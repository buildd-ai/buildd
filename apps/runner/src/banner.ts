/**
 * The runner's startup banner, as lines. Pure: index.ts gathers the facts and
 * the palette (detectTerminalPalette, the same OSC 11 probe `top` uses) and
 * prints. Labels and meta are muted; values are primary text in the terminal's
 * own foreground (R-17), so they read on any background.
 */
import type { Palette } from './terminal-palette';

export interface BannerInfo {
  version: string;
  commit: string;
  debug: boolean;
  port: number;
  server: string;
  apiKey: string;
  socketPath?: string | null;
  localUrl: string;
  remoteUrl?: string | null;
  bindHost?: string;
  tokenPath?: string | null;
  repos: number;
  reposCached: boolean;
  roots: number;
  serverless: boolean;
}

/** A clickable terminal link (OSC 8). */
export function terminalLink(url: string, text?: string): string {
  return `\x1b]8;;${url}\x07${text || url}\x1b]8;;\x07`;
}

const WORDMARK = [
  '   ██████╗  ██╗   ██╗ ██╗ ██╗     ██████╗  ██████╗ ',
  '   ██╔══██╗ ██║   ██║ ██║ ██║     ██╔══██╗ ██╔══██╗',
  '   ██████╔╝ ██║   ██║ ██║ ██║     ██║  ██║ ██║  ██║',
  '   ██╔══██╗ ██║   ██║ ██║ ██║     ██║  ██║ ██║  ██║',
  '   ██████╔╝ ╚██████╔╝ ██║ ███████╗██████╔╝ ██████╔╝',
  '   ╚═════╝   ╚═════╝  ╚═╝ ╚══════╝╚═════╝  ╚═════╝ ',
];

export function renderBanner(info: BannerInfo, p: Palette): string[] {
  const muted = (s: string) => p.fg('muted', s);
  const text = (s: string) => p.fg('text', s);
  const bold = (s: string) => p.bold(s);
  const row = (label: string, value: string) => `   ${muted(label.padEnd(8))} ${value}`;

  const out: string[] = [''];
  for (const l of WORDMARK) out.push(p.fg('accent', l));
  out.push('');
  out.push(`   ${muted('runner')} ${muted(`v${info.version}${info.commit ? ` · ${info.commit}` : ''}`)}`);
  out.push(p.fg('faint', `   ${'─'.repeat(48)}`));

  const mode = info.debug ? `${p.fg('accent', 'debug')} ${muted(`:${info.port}`)}` : p.fg('success', 'headless');
  out.push(row('mode', mode));
  out.push(row('server', text(info.server)));
  out.push(row('key', info.apiKey ? p.fg('success', `bld_···${info.apiKey.slice(-4)}`) : p.fg('error', 'not set')));
  if (info.socketPath) out.push(row('socket', text(info.socketPath)));
  if (info.debug) {
    out.push(row('url', text(terminalLink(info.localUrl))));
    if (info.remoteUrl && info.remoteUrl !== info.localUrl) out.push(row('remote', text(terminalLink(info.remoteUrl))));
    if (info.bindHost) out.push(row('bind', text(`${info.bindHost}:${info.port}`)));
    if (info.tokenPath) out.push(row('token', `${text(info.tokenPath)} ${muted('(send as X-Buildd-Local-Token for POST/DELETE)')}`));
  }

  out.push('');
  const s = (n: number) => (n !== 1 ? 's' : '');
  out.push(`   ${muted(`${info.repos} repo${s(info.repos)}${info.reposCached ? ' · cached' : ''} · ${info.roots} root${s(info.roots)}`)}`);

  if (!info.apiKey && !info.serverless) {
    out.push('');
    out.push(info.debug
      ? `   ${p.fg('error', '▸')} No API key — visit ${terminalLink(info.localUrl)} to set up`
      : `   ${p.fg('error', '▸')} Not logged in — run ${bold('buildd login')} (or set ${bold('BUILDD_API_KEY')}), then start buildd again`);
  }
  out.push('');
  return out;
}
