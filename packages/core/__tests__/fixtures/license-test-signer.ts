// TEST-ONLY signer. The seeds below are published fixtures that sign nothing
// real; no production key exists in this repository. Never import from product code.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const TEST_SEED_A = Buffer.alloc(32, 7);
export const TEST_SEED_B = Buffer.alloc(32, 9);

export function publicKeyOf(seed: Buffer): string {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return createPublicKey(priv).export({ format: 'jwk' }).x as string;
}

export function signToken(
  seed: Buffer,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'EdDSA', typ: 'buildd-license', kid: 'test-a' },
): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(payload)}`;
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), priv).toString('base64url')}`;
}

export const T0 = 1_790_000_000;
export const DAY = 86400;

export function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, iss: 'buildd-licensing', jti: 'lic_test_001',
    customer: { id: 'cust_test', name: 'Example Corp' },
    edition: 'team', features: ['collab'], limits: { maxSeats: 25 },
    iat: T0, nbf: T0, exp: T0 + 365 * DAY, kind: 'production',
    ...over,
  };
}
