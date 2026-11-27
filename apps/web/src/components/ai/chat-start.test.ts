import { describe, expect, it } from 'vitest';

import { isChatStartFor, type PendingChatStart } from './chat-start';

const pending: PendingChatStart = {
  workspaceId: 'ws',
  text: 'Hallo',
  files: [],
  requestId: 1,
  askedAt: 1000,
};

describe('isChatStartFor', () => {
  it('sends a fresh start from the panel of its own workspace', () => {
    expect(isChatStartFor(pending, 'ws', 1500)).toBe(true);
  });

  it('leaves a start to the panel of the workspace it was typed in', () => {
    expect(isChatStartFor(pending, 'other', 1500)).toBe(false);
  });

  it('never sends a start nobody picked up in time, on some later visit', () => {
    expect(isChatStartFor(pending, 'ws', 1000 + 10_000)).toBe(false);
  });

  it('has nothing to send without a start', () => {
    expect(isChatStartFor(null, 'ws', 1500)).toBe(false);
  });
});
