import { describe, expect, it } from 'vitest';

import { API_TOKEN_PREFIX } from './api-token';
import { hashShareToken } from './share-token';
import {
  generateUploadTicket,
  hashUploadTicket,
  looksLikeUploadTicket,
  uploadTicketUrl,
} from './upload-ticket';

/**
 * Upload-ticket secrets (ADR-064). What a rewrite could quietly lose: only a
 * hash is stored, the hash is not the one a share link would produce, and the
 * value is never mistaken for a bearer credential.
 */
describe('generateUploadTicket', () => {
  it('stores only a hash of a value it returns once', () => {
    const ticket = generateUploadTicket();
    expect(hashUploadTicket(ticket.secret)).toBe(ticket.tokenHash);
    expect(ticket.tokenHash).not.toContain(ticket.secret);
    expect(ticket.tokenHash).toHaveLength(64);
  });

  it('never produces the same secret twice', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateUploadTicket().secret));
    expect(secrets.size).toBe(200);
  });

  it('hashes apart from share links', () => {
    const { secret } = generateUploadTicket();
    expect(hashUploadTicket(secret)).not.toBe(hashShareToken(secret));
  });

  it('does not look like a bearer token', () => {
    expect(generateUploadTicket().secret.startsWith(API_TOKEN_PREFIX)).toBe(false);
  });
});

describe('looksLikeUploadTicket', () => {
  it('accepts what the generator makes', () => {
    expect(looksLikeUploadTicket(generateUploadTicket().secret)).toBe(true);
  });

  it('rejects anything else before the database is asked', () => {
    expect(looksLikeUploadTicket('')).toBe(false);
    expect(looksLikeUploadTicket('short')).toBe(false);
    expect(looksLikeUploadTicket(`${'a'.repeat(42)}/`)).toBe(false);
    expect(looksLikeUploadTicket('a'.repeat(44))).toBe(false);
  });
});

describe('uploadTicketUrl', () => {
  it('builds the redeem route under the public origin', () => {
    expect(uploadTicketUrl('https://exocortex.app', 'abc')).toBe(
      'https://exocortex.app/api/attachments/upload/abc',
    );
  });
});
