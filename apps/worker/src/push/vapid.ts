import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

import { decodeBase64Url, encodeBase64Url } from './encrypt';

/**
 * Voluntary Application Server Identification (RFC 8292).
 *
 * The signature is how a push service knows which application server a message
 * came from. It is not authorization -- anybody holding an endpoint can post to
 * it -- but it is what lets a service rate-limit, contact and, if it must,
 * block one sender rather than everyone. Firefox and Chrome both refuse a
 * payload without it.
 *
 * The key pair is generated once per deployment and lives in the environment,
 * never in the `setting` table: it is a credential, and ADR-023 keeps those out
 * of settings. Rotating it invalidates every subscription, because a browser's
 * endpoint is minted against the public key it was given -- which is why
 * `scripts/generate-vapid-keys.mjs` prints a warning and nothing rotates by
 * itself.
 */

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. Public: it goes to every browser. */
  publicKey: string;
  /** The 32-byte scalar, base64url. Secret. */
  privateKey: string;
  /**
   * How the push service can reach whoever runs this deployment, as a `mailto:`
   * or `https:` URL. Required by RFC 8292 and used in practice: a service with
   * a problem writes to it before it starts dropping messages.
   */
  subject: string;
}

/** A fresh key pair, for the generator script and for tests. */
export function generateVapidKeys(subject: string): VapidKeys {
  // Only the private key is read: a JWK of an EC private key carries the
  // public coordinates beside the scalar, so the pair is one export.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string') throw new Error('Generated key has no private scalar');

  return {
    publicKey: encodeBase64Url(
      Buffer.concat([
        Buffer.from([0x04]),
        decodeBase64Url(String(jwk.x)),
        decodeBase64Url(String(jwk.y)),
      ]),
    ),
    privateKey: jwk.d,
    subject,
  };
}

/**
 * The `Authorization` header for one endpoint.
 *
 * The token is bound to the push service's origin through `aud`, so a token
 * captured by one service cannot be replayed at another, and it expires -- the
 * RFC allows 24 hours and this takes twelve, because a clock that is off by an
 * hour must not make every notification fail.
 */
export function vapidAuthorizationHeader(
  keys: VapidKeys,
  endpoint: string,
  now: Date = new Date(),
): string {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  };

  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  /*
   * `ieee-p1363` is the whole reason this is three lines instead of thirty:
   * Node signs ECDSA as DER by default, and a JWT wants the raw r||s pair.
   * Asking for it here avoids unpacking an ASN.1 structure by hand.
   */
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${encodeBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * Rebuilds the signing key from the two stored strings.
 *
 * The public key carries the point and the private key carries the scalar, and
 * a JWK wants all three -- so the coordinates are split back out of the
 * uncompressed point rather than stored twice.
 */
function privateKeyObject(keys: VapidKeys): KeyObject {
  const point = decodeBase64Url(keys.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID public key is not an uncompressed P-256 point');
  }
  const scalar = decodeBase64Url(keys.privateKey);
  if (scalar.length !== 32) throw new Error('VAPID private key is not 32 bytes');

  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(point.subarray(1, 33)),
      y: encodeBase64Url(point.subarray(33, 65)),
      d: keys.privateKey,
    },
  });
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * Reads the key pair out of the environment, or says there is none.
 *
 * Absent is a normal state, not a fault: a deployment that never generated a
 * pair simply has no push notifications, and nothing else about it changes.
 */
export function vapidKeysFromEnv(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (publicKey === undefined || publicKey === '') return null;
  if (privateKey === undefined || privateKey === '') return null;
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost',
  };
}
