import { describe, test, expect } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'crypto';
import { signGitHubAppJwt } from '../src/github-app-jwt';

const fromB64url = (s: string) => Buffer.from(s, 'base64url').toString();

describe('signGitHubAppJwt', () => {
  for (const type of ['pkcs1', 'pkcs8'] as const) {
    test(`signs verifiable RS256 JWT with ${type} key`, () => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type, format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const jwt = signGitHubAppJwt('12345', privateKey, 1_700_000_000);
      const [h, p, s] = jwt.split('.');
      expect(JSON.parse(fromB64url(h))).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(JSON.parse(fromB64url(p))).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_600, iss: '12345' });
      expect(jwt).not.toMatch(/[+/=]/);
      const v = createVerify('RSA-SHA256');
      v.update(`${h}.${p}`);
      expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    });
  }
});
