/**
 * The deployment-action request that ships this Worker
 * (docs/specs/deployment-actions.md). Pure: the script reads wrangler.jsonc
 * and the built bundle and hands them here.
 *
 * The same request serves both principals: a Platform Operator task passes it
 * to the `deploy` MCP action, a person with an admin key POSTs it to
 * /api/deployments. Neither path puts a Cloudflare token on the machine.
 */

export interface WranglerSettings {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

/** Strip // and /* *\/ comments outside strings, then trailing commas. */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readWranglerSettings(jsonc: string): WranglerSettings {
  const cfg = JSON.parse(stripJsonc(jsonc)) as { name?: unknown; compatibility_date?: unknown; compatibility_flags?: unknown };
  if (typeof cfg.name !== 'string' || typeof cfg.compatibility_date !== 'string') {
    throw new Error('wrangler.jsonc needs "name" and "compatibility_date"');
  }
  const flags = Array.isArray(cfg.compatibility_flags) ? cfg.compatibility_flags.filter((f): f is string => typeof f === 'string') : [];
  return { name: cfg.name, compatibilityDate: cfg.compatibility_date, compatibilityFlags: flags };
}

export interface DeployTarget {
  project: string;
  environment: string;
  credentialRef: string;
}

/**
 * The upload_worker request for a built bundle (`wrangler deploy --dry-run
 * --outdir <dir>`). Only JavaScript modules are sent: source maps and the
 * README wrangler writes stay behind. The main module is wrangler's output
 * for `main`, `index.js`.
 */
export function uploadRequest(settings: WranglerSettings, files: Array<{ name: string; content: string }>, target: DeployTarget) {
  const modules = files
    .filter(f => /\.(m?js)$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const main = modules.find(m => m.name === 'index.js') ?? modules[0];
  if (!main) throw new Error('the bundle has no JavaScript module; run `wrangler deploy --dry-run --outdir <dir>` first');
  return {
    provider: 'cloudflare' as const,
    project: target.project,
    environment: target.environment,
    credentialRef: target.credentialRef,
    operation: 'upload_worker' as const,
    params: {
      mainModule: main.name,
      modules,
      compatibilityDate: settings.compatibilityDate,
      compatibilityFlags: settings.compatibilityFlags,
    },
  };
}
