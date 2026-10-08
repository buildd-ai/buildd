import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWranglerSettings, uploadRequest } from './deploy-request';
// The web app's parser is the one that will judge this request.
import { parseDeploymentRequest } from '../../web/src/lib/deployments/action';
import { parseCloudflareParams, cloudflareScriptName } from '../../web/src/lib/deployments/cloudflare';

const WRANGLER = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8');

describe('model-policy deploy request', () => {
  it('reads name and compatibility settings from the checked-in wrangler.jsonc, comments and all', () => {
    const s = readWranglerSettings(WRANGLER);
    expect(s.name).toBe('model-policy');
    expect(s.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.compatibilityFlags).toContain('nodejs_compat');
  });

  it('keeps comment-like text inside strings', () => {
    expect(readWranglerSettings('{ "name": "a//b", "compatibility_date": "2026-01-01", /* x */ }').name).toBe('a//b');
  });

  it('sends JavaScript modules only, and is a request the server accepts', () => {
    const req = uploadRequest(readWranglerSettings(WRANGLER), [
      { name: 'index.js', content: 'export default {}' },
      { name: 'index.js.map', content: '{}' },
      { name: 'README.md', content: 'x' },
    ], { project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod' });
    expect(req.params.modules.map(m => m.name)).toEqual(['index.js']);
    expect(req.params.mainModule).toBe('index.js');

    const parsed = parseDeploymentRequest(req);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const script = cloudflareScriptName(parsed.request.project, parsed.request.environment);
    expect(script).toBe('model-policy');
    expect(parseCloudflareParams('upload_worker', parsed.request.params, script).ok).toBe(true);
  });

  it('carries no credential: the request has nowhere to put one', () => {
    const req = uploadRequest(readWranglerSettings(WRANGLER), [{ name: 'index.js', content: '' }], { project: 'model-policy', environment: 'staging', credentialRef: 'cloudflare' });
    expect(Object.keys(req).sort()).toEqual(['credentialRef', 'environment', 'operation', 'params', 'project', 'provider']);
    expect(Object.keys(req.params).sort()).toEqual(['compatibilityDate', 'compatibilityFlags', 'mainModule', 'modules']);
  });

  it('refuses an empty bundle', () => {
    expect(() => uploadRequest(readWranglerSettings(WRANGLER), [{ name: 'README.md', content: '' }], { project: 'p', environment: 'e', credentialRef: 'c' })).toThrow();
  });
});
