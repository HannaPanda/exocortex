import { describe, expect, it } from 'vitest';

import { UPLOAD_TICKET_TTL_SECONDS } from '@exocortex/contracts';

import { ticketExpiry, type TicketMinter, ticketState } from './upload-tickets.service';

/** The two pure decisions of the upload-ticket service (ADR-064). */
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const STANDARD = NOW + UPLOAD_TICKET_TTL_SECONDS * 1000;

function minter(credential: TicketMinter['credential'], expiresAt: number): TicketMinter {
  return {
    userId: 'u',
    credential,
    apiTokenId: undefined,
    credentialExpiresAt: new Date(expiresAt),
  };
}

describe('ticketExpiry', () => {
  it('gives the standard lifetime to a credential that outlives it', () => {
    expect(ticketExpiry(minter('api_token', NOW + 86_400_000), NOW).getTime()).toBe(STANDARD);
  });

  it('never outlives the token or session that minted it', () => {
    expect(ticketExpiry(minter('api_token', NOW + 30_000), NOW).getTime()).toBe(NOW + 30_000);
    expect(ticketExpiry(minter('session', NOW + 30_000), NOW).getTime()).toBe(NOW + 30_000);
  });

  it("is not cut to a service token's two-minute life", () => {
    // An OAuth MCP call runs on a loopback token that lives 120 s; capping at
    // it would hand out tickets that expire before a script runs.
    expect(ticketExpiry(minter('service_token', NOW + 120_000), NOW).getTime()).toBe(STANDARD);
  });
});

describe('ticketState', () => {
  it('reads open, used and expired', () => {
    const later = new Date(NOW + 1000);
    const earlier = new Date(NOW - 1000);
    expect(ticketState({ usedAt: null, expiresAt: later }, NOW)).toBe('open');
    expect(ticketState({ usedAt: null, expiresAt: earlier }, NOW)).toBe('expired');
    // Used wins over expired: a file that arrived in time stays arrived.
    expect(ticketState({ usedAt: earlier, expiresAt: earlier }, NOW)).toBe('used');
  });
});
