import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createCorrelationId } from './logger';
import { REDACTED_PATHS, REDACTION_PLACEHOLDER } from './redaction';

/**
 * The redaction list is the security-relevant part of the logger, so it is
 * asserted directly against a pino instance configured the same way as
 * `createLogger`.
 */
function captureLine(payload: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = pino(
    { redact: { paths: [...REDACTED_PATHS], censor: REDACTION_PLACEHOLDER, remove: false } },
    stream,
  );
  logger.info(payload, 'test');
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('log redaction', () => {
  it('redacts passwords and session tokens', () => {
    const line = captureLine({ password: 'hunter2', sessionToken: 'abc', userId: 'user_1' });
    expect(line.password).toBe(REDACTION_PLACEHOLDER);
    expect(line.sessionToken).toBe(REDACTION_PLACEHOLDER);
    expect(line.userId).toBe('user_1');
  });

  it('redacts document payloads so contents never reach logs', () => {
    const line = captureLine({ markdown: '# secret notes', plainText: 'secret', documentId: 'd1' });
    expect(line.markdown).toBe(REDACTION_PLACEHOLDER);
    expect(line.plainText).toBe(REDACTION_PLACEHOLDER);
    expect(line.documentId).toBe('d1');
  });

  it('redacts collaboration tickets', () => {
    const line = captureLine({ ticket: 'signed.payload.value' });
    expect(line.ticket).toBe(REDACTION_PLACEHOLDER);
  });
});

describe('createCorrelationId', () => {
  it('creates unique identifiers', () => {
    expect(createCorrelationId()).not.toBe(createCorrelationId());
  });
});
