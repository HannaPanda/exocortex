import { describe, expect, it } from 'vitest';

import { parseChatCommand } from './chat-commands';

describe('parseChatCommand', () => {
  it('parses a command with no argument', () => {
    expect(parseChatCommand('/clear')).toEqual({ name: 'clear', argument: null });
  });

  it('parses a command with an argument', () => {
    expect(parseChatCommand('/model z-ai/glm-5.2')).toEqual({
      name: 'model',
      argument: 'z-ai/glm-5.2',
    });
  });

  it('parses another known command with an argument', () => {
    expect(parseChatCommand('/think high')).toEqual({ name: 'think', argument: 'high' });
  });

  it('returns null for an unknown command', () => {
    expect(parseChatCommand('/nope')).toBeNull();
  });

  it('returns null when the message does not start with a slash', () => {
    expect(parseChatCommand('Was macht /clear?')).toBeNull();
  });

  it('treats a path-like message as prose, not a command', () => {
    expect(parseChatCommand('/tmp/foo ist kaputt')).toBeNull();
  });

  it('trims the argument and collapses trailing whitespace to null', () => {
    expect(parseChatCommand('/clear   ')).toEqual({ name: 'clear', argument: null });
  });

  it('keeps internal whitespace of the argument intact', () => {
    expect(parseChatCommand('/new  Mein neuer Chat  ')).toEqual({
      name: 'new',
      argument: 'Mein neuer Chat',
    });
  });
});
