import { describe, expect, it } from 'vitest';

import { describeApiError, ExocortexApiError } from './client.js';

describe('describeApiError', () => {
  it('names the reason and the correlation id the server logged under', () => {
    // Issue #82. `validation_failed` on its own sent people bisecting their own
    // document: the cause was in the server log all along, behind an id the
    // caller never saw.
    const error = new ExocortexApiError(
      'validation_failed',
      'The Markdown document could not be parsed',
      400,
      'a1647f6a-8d3c-4c5f-9f4a-2b1e0c7d5e93',
      { reason: 'Refusing to apply an invalid document: Invalid content for node listItem: <>' },
    );

    expect(describeApiError(error)).toBe(
      'Fehler (validation_failed): The Markdown document could not be parsed: ' +
        'Refusing to apply an invalid document: Invalid content for node listItem: <> ' +
        '[Vorgang a1647f6a-8d3c-4c5f-9f4a-2b1e0c7d5e93]',
    );
  });

  it('falls back to the message alone when there is nothing else', () => {
    const error = new ExocortexApiError('not_found', 'Document was not found', 404, null);
    expect(describeApiError(error)).toBe('Fehler (not_found): Document was not found');
  });

  it('ignores details that carry no reason', () => {
    const error = new ExocortexApiError('validation_failed', 'Bad input', 400, 'abc', ['x']);
    expect(describeApiError(error)).toBe('Fehler (validation_failed): Bad input [Vorgang abc]');
  });
});
