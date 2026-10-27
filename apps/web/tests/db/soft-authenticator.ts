/**
 * A software WebAuthn authenticator for tests: one P-256 credential that
 * answers registration and assertion options with the bytes a real
 * authenticator sends (attestation "none", ES256), so
 * @simplewebauthn/server verifies them for real. `present: false` clears the
 * user-present flag, which no real passkey prompt does.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const text = (s: string) => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export function softAuthenticator(rpID: string, origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // COSE_Key { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url'),
  ]);
  const credentialId = randomBytes(16);
  const id = b64u(credentialId);
  let counter = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id,
    register(options: { challenge: string }) {
      const authData = Buffer.concat([
        sha256(rpID), Buffer.from([0x45]), u32(0), Buffer.alloc(16),
        Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, cose,
      ]);
      const attestation = Buffer.concat([
        Buffer.from([0xa3]), text('fmt'), text('none'), text('attStmt'), Buffer.from([0xa0]), text('authData'),
        Buffer.from([0x59, authData.length >> 8, authData.length & 0xff]), authData,
      ]);
      return {
        id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge)), attestationObject: b64u(attestation), transports: ['internal'] },
      };
    },
    assert(options: { challenge: string }, opts: { present?: boolean } = {}) {
      counter += 1;
      const authData = Buffer.concat([sha256(rpID), Buffer.from([opts.present === false ? 0x00 : 0x05]), u32(counter)]);
      const data = clientData('webauthn.get', options.challenge);
      const signature = sign('sha256', Buffer.concat([authData, sha256(data)]), privateKey);
      return {
        id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(data), authenticatorData: b64u(authData), signature: b64u(signature) },
      };
    },
  };
}
