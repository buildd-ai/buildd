/**
 * GitHub App JWT signer — the one definition for the monorepo.
 * Node-only (crypto): `import { signGitHubAppJwt } from '@buildd/shared/github-app-jwt'`.
 *
 * RS256, `iat` 60s in the past (clock drift), `exp` 10 minutes out, `iss` the
 * app id. createPrivateKey accepts both PKCS#1 and PKCS#8. Callers read their
 * own env (and decide when) and pass the values in.
 */
import { createSign, createPrivateKey } from 'crypto';

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

export function signGitHubAppJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 600, iss: appId }));
  const input = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${b64url(signer.sign(createPrivateKey(privateKey)))}`;
}
