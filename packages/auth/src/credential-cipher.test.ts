import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CredentialCipherError,
  credentialHint,
  decryptCredential,
  encryptCredential,
  parseCredentialKey,
} from './credential-cipher';

const key = randomBytes(32);
const purpose = 'AI_OPENROUTER';

describe('credential cipher', () => {
  it('round-trips a secret', () => {
    const record = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    expect(record.ciphertext).not.toContain('secret');
    expect(decryptCredential({ key, purpose, record })).toBe('sk-or-v1-secret');
  });

  it('encrypts the same secret differently every time', () => {
    const first = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    const second = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it('refuses a record encrypted for another purpose', () => {
    const record = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    expect(() => decryptCredential({ key, purpose: 'SOMETHING_ELSE', record })).toThrow(
      CredentialCipherError,
    );
  });

  it('refuses a tampered ciphertext instead of returning bytes', () => {
    const record = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    const tampered = {
      ...record,
      ciphertext: Buffer.from('sk-or-v1-attacker', 'utf8').toString('base64'),
    };
    expect(() => decryptCredential({ key, purpose, record: tampered })).toThrow(
      CredentialCipherError,
    );
  });

  it('refuses another deployment key', () => {
    const record = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    expect(() => decryptCredential({ key: randomBytes(32), purpose, record })).toThrow(
      CredentialCipherError,
    );
  });

  it('refuses a record written by a future key version', () => {
    const record = encryptCredential({ key, purpose, plaintext: 'sk-or-v1-secret' });
    expect(() => decryptCredential({ key, purpose, record: { ...record, keyVersion: 2 } })).toThrow(
      /key version 2/,
    );
  });

  describe('parseCredentialKey', () => {
    it('reads a 32 byte base64 key', () => {
      expect(parseCredentialKey(key.toString('base64'))?.byteLength).toBe(32);
    });

    it('treats an unset or empty variable as "no BYOK", not as an error', () => {
      expect(parseCredentialKey(undefined)).toBeNull();
      expect(parseCredentialKey('   ')).toBeNull();
    });

    it('names a key of the wrong length instead of accepting it', () => {
      expect(() => parseCredentialKey(randomBytes(16).toString('base64'))).toThrow(
        CredentialCipherError,
      );
    });
  });

  describe('credentialHint', () => {
    it('keeps the last four characters of a real key', () => {
      expect(credentialHint('sk-or-v1-abcdef1234')).toBe('1234');
    });

    it('gives no hint at all for a secret short enough to be guessed from one', () => {
      expect(credentialHint('short')).toBe('');
    });
  });
});
