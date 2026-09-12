import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for stored third-party credentials (issue #52, AP7).
 *
 * ADR-013 draws the line this file sits on: a setting is a preference and
 * never a credential, so a workspace's own provider key cannot live in
 * `setting` or `workspace_setting`. It lives in `workspace_credential`, and
 * everything in that table is encrypted here before it is written.
 *
 * AES-256-GCM rather than plain AES: the authentication tag makes a tampered
 * ciphertext fail loudly at `decrypt` instead of yielding plausible bytes that
 * are then sent to a provider as somebody's API key. The key comes from
 * `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64) and stays in the environment;
 * a deployment that never sets it simply has no BYOK, exactly as an unset
 * `SERVICE_TOKEN_SECRET` means no tool loop. Nothing here may stop a process
 * from booting.
 */

/** 96 bits, the size GCM is specified for. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Which key material this record was encrypted with.
 *
 * Stored per row so a future key rotation can re-encrypt in the background
 * instead of in one migration: a reader that meets an unknown version says so
 * rather than handing the provider garbage. There is one version today.
 */
export const CREDENTIAL_KEY_VERSION = 1;

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export class CredentialCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCipherError';
  }
}

/**
 * Parses the configured key, or `null` when none is configured.
 *
 * Deliberately not throwing on an absent variable: "no key" is a supported
 * deployment, "a key of the wrong length" is a configuration error worth
 * naming, because silently falling back to no encryption would store the next
 * secret in the clear.
 */
export function parseCredentialKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new CredentialCipherError(
      `CREDENTIAL_ENCRYPTION_KEY must be ${String(KEY_BYTES)} bytes of base64, got ${String(key.byteLength)}`,
    );
  }
  return key;
}

/**
 * Encrypts one secret.
 *
 * `purpose` is bound in as additional authenticated data, so a row moved from
 * one purpose to another fails to decrypt rather than being used as a key for
 * a service it was never meant for.
 */
export function encryptCredential(input: {
  key: Buffer;
  purpose: string;
  plaintext: string;
}): EncryptedCredential {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', input.key, iv);
  cipher.setAAD(Buffer.from(input.purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: CREDENTIAL_KEY_VERSION,
  };
}

/** Reverses `encryptCredential`. Throws when the record was tampered with. */
export function decryptCredential(input: {
  key: Buffer;
  purpose: string;
  record: EncryptedCredential;
}): string {
  if (input.record.keyVersion !== CREDENTIAL_KEY_VERSION) {
    throw new CredentialCipherError(
      `Credential was encrypted with key version ${String(input.record.keyVersion)}, this deployment has ${String(CREDENTIAL_KEY_VERSION)}`,
    );
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    input.key,
    Buffer.from(input.record.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(input.purpose, 'utf8'));
  decipher.setAuthTag(Buffer.from(input.record.authTag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(input.record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Node throws a bare "Unsupported state or unable to authenticate data"
    // here, which says nothing about which of the three inputs is wrong.
    throw new CredentialCipherError('Credential could not be decrypted (wrong key or tampered)');
  }
}

/**
 * The last four characters of a secret, the only part ever shown again.
 *
 * Enough for a person to recognise which key is stored without the value being
 * useful to anyone who reads it. Short secrets get no hint at all rather than
 * a hint that is most of them.
 */
export function credentialHint(plaintext: string): string {
  return plaintext.length >= 12 ? plaintext.slice(-4) : '';
}
