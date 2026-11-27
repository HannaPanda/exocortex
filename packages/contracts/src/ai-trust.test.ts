import { describe, expect, it } from 'vitest';

import {
  type AiMutationPolicy,
  attachmentTrustFor,
  attachmentTrustNote,
  decideMutation,
  fenceUntrustedContent,
  isUntrustedOrigin,
  UNTRUSTED_CONTENT_SECTION,
  type UntrustedOrigin,
} from './ai-trust';

const NOTHING_READ: readonly UntrustedOrigin[] = [];
const READ_A_DOCUMENT: readonly UntrustedOrigin[] = ['attachment'];

describe('decideMutation', () => {
  it('never stands in the way of a read-only tool', () => {
    for (const policy of ['deny', 'guarded', 'allow'] satisfies AiMutationPolicy[]) {
      const decision = decideMutation({
        policy,
        mutating: false,
        untrustedOrigins: READ_A_DOCUMENT,
      });
      expect(decision.allowed).toBe(true);
    }
  });

  it('lets a guarded run write while everything it read came from here', () => {
    const decision = decideMutation({
      policy: 'guarded',
      mutating: true,
      untrustedOrigins: NOTHING_READ,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses a write once a guarded run has read foreign text', () => {
    const decision = decideMutation({
      policy: 'guarded',
      mutating: true,
      untrustedOrigins: READ_A_DOCUMENT,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('untrusted_context');
  });

  it('names every origin the run read, each one once', () => {
    const decision = decideMutation({
      policy: 'guarded',
      mutating: true,
      untrustedOrigins: ['attachment', 'web', 'attachment'],
    });
    expect(decision.allowed).toBe(false);
    const message = decision.allowed === false ? decision.message : '';
    expect(message).toContain('hochgeladenen Dokument');
    expect(message).toContain('dem Web');
    expect(message.match(/hochgeladenen Dokument/g)).toHaveLength(1);
  });

  it('refuses a write in a read-only run even before anything was read', () => {
    const decision = decideMutation({
      policy: 'deny',
      mutating: true,
      untrustedOrigins: NOTHING_READ,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('mutations_disabled');
  });

  it('lets a declared workflow keep writing after foreign text', () => {
    const decision = decideMutation({
      policy: 'allow',
      mutating: true,
      untrustedOrigins: ['attachment', 'web'],
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('fenceUntrustedContent', () => {
  it('marks both ends, so a cut-off fence cannot pass as an open one', () => {
    const fenced = fenceUntrustedContent({
      origin: 'attachment',
      label: 'rechnung.pdf',
      text: 'Hallo',
    });
    expect(fenced.startsWith('<<<FREMDINHALT')).toBe(true);
    expect(fenced.trimEnd().endsWith('<<<ENDE FREMDINHALT>>>')).toBe(true);
    expect(fenced).toContain('rechnung.pdf');
    expect(fenced).toContain('Hallo');
  });

  it('says where the text came from', () => {
    expect(fenceUntrustedContent({ origin: 'web', text: 'x' })).toContain('aus dem Web');
  });

  it('uses the same markers the system prompt tells the model about', () => {
    const fenced = fenceUntrustedContent({ origin: 'mail', text: 'x' });
    const opening = fenced.split('\n')[0] ?? '';
    expect(UNTRUSTED_CONTENT_SECTION).toContain(opening.slice(0, '<<<FREMDINHALT'.length));
    expect(UNTRUSTED_CONTENT_SECTION).toContain('<<<ENDE FREMDINHALT>>>');
  });
});

describe('isUntrustedOrigin', () => {
  it('trusts this deployment and nothing else', () => {
    expect(isUntrustedOrigin('internal')).toBe(false);
    expect(isUntrustedOrigin('attachment')).toBe(true);
    expect(isUntrustedOrigin('web')).toBe(true);
    expect(isUntrustedOrigin('mail')).toBe(true);
    expect(isUntrustedOrigin('external-mcp')).toBe(true);
  });
});

describe('attachmentTrustFor (ADR-096)', () => {
  const own = {
    createdById: 'user-1',
    readerId: 'user-1',
    fetchedFromUrl: false,
    screening: 'clean' as const,
  };

  it("trusts only the reader's own upload, screened clean", () => {
    expect(attachmentTrustFor(own)).toEqual({ trusted: true, reason: 'own_screened' });
  });

  it("keeps somebody else's file foreign, however clean", () => {
    expect(attachmentTrustFor({ ...own, readerId: 'user-2' }).reason).toBe('not_own');
    expect(attachmentTrustFor({ ...own, correctedById: 'user-2' }).reason).toBe('not_own');
    expect(attachmentTrustFor({ ...own, correctedById: 'user-1' }).trusted).toBe(true);
  });

  it('fails closed for a web fetch, a finding, a failed and a missing screening', () => {
    expect(attachmentTrustFor({ ...own, fetchedFromUrl: true }).reason).toBe('fetched');
    expect(attachmentTrustFor({ ...own, screening: 'flagged' }).reason).toBe('flagged');
    expect(attachmentTrustFor({ ...own, screening: 'failed' }).reason).toBe('screen_failed');
    expect(attachmentTrustFor({ ...own, screening: null }).reason).toBe('unscreened');
  });

  it('explains only the cases the reader could not guess', () => {
    expect(attachmentTrustNote({ trusted: true, reason: 'own_screened' })).toBeNull();
    expect(attachmentTrustNote({ trusted: false, reason: 'not_own' })).toBeNull();
    expect(attachmentTrustNote({ trusted: false, reason: 'flagged' })).toContain('fiel');
    expect(attachmentTrustNote({ trusted: false, reason: 'unscreened' })).toContain('geprüft');
  });
});
