import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeBase64Url } from './encrypt';
import { generateVapidKeys, vapidAuthorizationHeader, vapidKeysFromEnv } from './vapid';

const keys = generateVapidKeys('mailto:johanna@example.org');

function parse(header: string): { token: string; key: string } {
  const match = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header);
  const [, token, key] = match ?? [];
  if (token === undefined || key === undefined) throw new Error(`Not a VAPID header: ${header}`);
  return { token, key };
}

function part(token: string, index: number): string {
  const value = token.split('.')[index];
  if (value === undefined)
    throw new Error(`A JWT has three parts, this has ${token.split('.').length}`);
  return value;
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(decodeBase64Url(part(token, 1)).toString('utf8')) as Record<string, unknown>;
}

describe('vapidAuthorizationHeader', () => {
  it('signs a token the public key verifies', () => {
    const { token, key } = parse(vapidAuthorizationHeader(keys, 'https://fcm.googleapis.com/x/y'));
    const header = part(token, 0);
    const payload = part(token, 1);
    const signature = part(token, 2);

    const point = decodeBase64Url(key);
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
    });

    const verified = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      decodeBase64Url(signature),
    );
    expect(verified).toBe(true);
  });

  it('binds the token to the push service origin and not to the endpoint path', () => {
    const one = vapidAuthorizationHeader(keys, 'https://updates.push.services.mozilla.com/wpush/a');
    const two = vapidAuthorizationHeader(keys, 'https://updates.push.services.mozilla.com/wpush/b');

    expect(claims(parse(one).token).aud).toBe('https://updates.push.services.mozilla.com');
    expect(claims(parse(one).token)).toEqual(claims(parse(two).token));
  });

  it('expires within the day the RFC allows', () => {
    const now = new Date('2026-09-20T10:00:00Z');
    const payload = claims(parse(vapidAuthorizationHeader(keys, 'https://x.test/y', now)).token);

    const seconds = Number(payload.exp) - Math.floor(now.getTime() / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(24 * 60 * 60);
    expect(payload.sub).toBe('mailto:johanna@example.org');
  });

  it('generates a public key in the form a browser expects', () => {
    const point = decodeBase64Url(keys.publicKey);
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
    expect(decodeBase64Url(keys.privateKey).length).toBe(32);
  });
});

describe('vapidKeysFromEnv', () => {
  it('is null when either half is missing, because half a pair signs nothing', () => {
    expect(vapidKeysFromEnv({})).toBeNull();
    expect(vapidKeysFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey })).toBeNull();
    expect(vapidKeysFromEnv({ VAPID_PRIVATE_KEY: keys.privateKey })).toBeNull();
    expect(
      vapidKeysFromEnv({ VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: keys.privateKey }),
    ).toBeNull();
  });

  it('reads both halves and falls back to a subject', () => {
    const read = vapidKeysFromEnv({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
    });
    expect(read?.publicKey).toBe(keys.publicKey);
    expect(read?.subject).toMatch(/^mailto:/);
  });
});
