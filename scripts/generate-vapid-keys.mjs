#!/usr/bin/env node
/**
 * Prints a VAPID key pair for `.env` (issue #30, ADR-048).
 *
 * Run once per deployment. Rotating the pair invalidates every existing
 * subscription -- a browser's push endpoint is minted against the public key
 * it was handed -- so this script refuses to look like a maintenance task and
 * says so instead.
 */

import { generateKeyPairSync } from 'node:crypto';

// The private key's JWK carries the public coordinates too, so one export
// yields both halves.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });

const point = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

process.stdout.write(
  [
    '# Web Push application server keys (issue #30, ADR-048).',
    '# Paste both lines into .env; the private half belongs in Infisical too.',
    '#',
    '# Generating a new pair invalidates every device that has already agreed to',
    '# be notified. They all have to say yes again, so do this once.',
    `VAPID_PUBLIC_KEY=${point}`,
    `VAPID_PRIVATE_KEY=${jwk.d}`,
    '',
  ].join('\n'),
);
