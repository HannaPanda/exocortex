import { describe, expect, it } from 'vitest';

import { issueCollaborationTicket, verifyCollaborationTicket } from './collaboration-ticket';

const secret = 'a'.repeat(64);
const otherSecret = 'b'.repeat(64);

function issue(overrides: Partial<Parameters<typeof issueCollaborationTicket>[0]> = {}) {
  return issueCollaborationTicket({
    secret,
    userId: 'user_1',
    documentId: 'document_1',
    access: 'write',
    ttlSeconds: 60,
    ...overrides,
  });
}

describe('collaboration tickets', () => {
  it('issues a verifiable ticket', () => {
    const { ticket, expiresAt } = issue();
    const result = verifyCollaborationTicket({
      secret,
      ticket,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid).toBe(true);
    expect(result.valid && result.claims.userId).toBe('user_1');
    expect(result.valid && result.claims.access).toBe('write');
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('produces a different ticket every time', () => {
    expect(issue().ticket).not.toBe(issue().ticket);
  });

  it('rejects a ticket signed with a different secret', () => {
    const { ticket } = issue();
    const result = verifyCollaborationTicket({
      secret: otherSecret,
      ticket,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('bad_signature');
  });

  it('rejects a tampered access claim', () => {
    const { ticket } = issue({ access: 'read' });
    const [payload, signature] = ticket.split('.') as [string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      access: string;
    };
    decoded.access = 'write';
    const forged = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${signature}`;

    const result = verifyCollaborationTicket({
      secret,
      ticket: forged,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('bad_signature');
  });

  it('rejects an expired ticket', () => {
    const { ticket } = issue({ ttlSeconds: 60, now: Date.now() - 120_000 });
    const result = verifyCollaborationTicket({
      secret,
      ticket,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('expired');
  });

  it('rejects a ticket issued for another document', () => {
    const { ticket } = issue({ documentId: 'document_other' });
    const result = verifyCollaborationTicket({
      secret,
      ticket,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('document_mismatch');
  });

  it('rejects malformed tickets', () => {
    for (const ticket of ['', 'no-dot', 'a.b.c', 'not-base64.signature']) {
      const result = verifyCollaborationTicket({
        secret,
        ticket,
        expectedDocumentId: 'document_1',
      });
      expect(result.valid).toBe(false);
    }
  });

  it('keeps read-only tickets read-only', () => {
    const { ticket } = issue({ access: 'read' });
    const result = verifyCollaborationTicket({
      secret,
      ticket,
      expectedDocumentId: 'document_1',
    });
    expect(result.valid && result.claims.access).toBe('read');
  });
});
