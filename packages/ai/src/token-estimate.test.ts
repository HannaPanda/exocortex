import { describe, expect, it } from 'vitest';

import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from './token-estimate';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is monotonic in the length of the text', () => {
    const short = estimateTokens('Hallo');
    const long = estimateTokens('Hallo, das ist ein deutlich längerer Beispieltext.');
    expect(long).toBeGreaterThan(short);
  });
});

describe('estimateMessageTokens', () => {
  it('counts the per-message overhead on top of the content estimate', () => {
    const content = 'Ein kurzer Testsatz.';
    const withoutOverhead = estimateTokens(content);
    const withOverhead = estimateMessageTokens({ role: 'user', content });
    expect(withOverhead).toBe(withoutOverhead + 4);
  });

  it('still charges the overhead for an empty message', () => {
    expect(estimateMessageTokens({ role: 'assistant', content: '' })).toBe(4);
  });
});

describe('estimateConversationTokens', () => {
  it('sums the per-message estimates', () => {
    const messages = [
      { role: 'system', content: 'Systemprompt' },
      { role: 'user', content: 'Frage' },
      { role: 'assistant', content: 'Antwort' },
    ];
    const total = estimateConversationTokens(messages);
    const expected = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    expect(total).toBe(expected);
  });

  it('returns 0 for an empty conversation', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });
});
