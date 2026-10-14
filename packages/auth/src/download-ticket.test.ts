import { describe, expect, it } from 'vitest';

import {
  downloadTicketUrl,
  generateDownloadTicket,
  hashDownloadTicket,
  looksLikeDownloadTicket,
} from './download-ticket';
import { hashUploadTicket } from './upload-ticket';

describe('generateDownloadTicket', () => {
  it('stores only a hash of a value it returns once', () => {
    const ticket = generateDownloadTicket();
    expect(hashDownloadTicket(ticket.secret)).toBe(ticket.tokenHash);
    expect(ticket.tokenHash).not.toContain(ticket.secret);
    expect(looksLikeDownloadTicket(ticket.secret)).toBe(true);
  });

  it('hashes apart from upload tickets', () => {
    const { secret } = generateDownloadTicket();
    expect(hashDownloadTicket(secret)).not.toBe(hashUploadTicket(secret));
  });

  it('rejects what cannot be a ticket before any lookup', () => {
    expect(looksLikeDownloadTicket('exo_abc')).toBe(false);
    expect(looksLikeDownloadTicket('')).toBe(false);
  });

  it('builds the address under the download path', () => {
    expect(downloadTicketUrl('https://exocortex.app', 'abc')).toBe(
      'https://exocortex.app/api/attachments/download/abc',
    );
  });
});
