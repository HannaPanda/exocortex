import { describe, expect, it } from 'vitest';

import {
  colonMayOpenAfter,
  emojiQueryBefore,
  endsInsideMarkdownCode,
  enterChoosesEmoji,
  isEmojiQuery,
} from './emoji-shortcode';

/** The query at the end of `text`, as the chat field would see it. */
function queryAtEnd(text: string): string | null {
  return emojiQueryBefore(text, text.length)?.query ?? null;
}

describe('the `:` emoji query (issue #269)', () => {
  it('opens after a colon followed by a letter', () => {
    expect(queryAtEnd(':h')).toBe('h');
    expect(queryAtEnd('Gut gemacht :herz')).toBe('herz');
    expect(queryAtEnd('(:tada')).toBe('tada');
    expect(queryAtEnd('Gut :Daumen_hoch')).toBe('Daumen_hoch');
    expect(queryAtEnd('Ja :+1')).toBe('+1');
    expect(queryAtEnd('Ja :über')).toBe('über');
  });

  it('opens nothing for a colon alone or an emoticon', () => {
    expect(queryAtEnd(':')).toBeNull();
    expect(queryAtEnd('so :')).toBeNull();
    expect(queryAtEnd('so :)')).toBeNull();
    expect(queryAtEnd('so :-(')).toBeNull();
    expect(queryAtEnd('so :1')).toBeNull();
    expect(queryAtEnd(':herz ')).toBeNull();
  });

  it('opens nothing for a colon inside a word, a time, an address or a notation', () => {
    expect(queryAtEnd('um 12:30')).toBeNull();
    expect(queryAtEnd('um 12:3')).toBeNull();
    expect(queryAtEnd('Verhältnis 3:x')).toBeNull();
    expect(queryAtEnd('https://exocortex')).toBeNull();
    expect(queryAtEnd('mailto:jemand')).toBeNull();
    expect(queryAtEnd('Hinweis:text')).toBeNull();
    expect(queryAtEnd('a::b')).toBeNull();
    expect(queryAtEnd('C:\\:x')).toBeNull();
  });

  it('opens again after an emoji typed just before, so two can follow each other', () => {
    expect(queryAtEnd('🎉:herz')).toBe('herz');
    expect(queryAtEnd('❤️:tada')).toBe('tada');
  });

  it('opens nothing inside Markdown code', () => {
    expect(queryAtEnd('`a :herz')).toBeNull();
    expect(queryAtEnd('``a ` :herz')).toBeNull();
    expect(queryAtEnd('```\nconst a = :herz')).toBeNull();
    expect(queryAtEnd('~~~js\nx :herz')).toBeNull();
  });

  it('opens after a closed code span or a closed fence', () => {
    expect(queryAtEnd('`a` :herz')).toBe('herz');
    expect(queryAtEnd('```\ncode\n```\n:herz')).toBe('herz');
  });

  it('follows the caret, not the end of the text', () => {
    const text = 'Gut :herz und mehr';
    expect(emojiQueryBefore(text, 9)).toEqual({ from: 4, to: 9, query: 'herz' });
    expect(emojiQueryBefore(text, text.length)).toBeNull();
  });

  it('reads the pieces the editor shares with the chat field', () => {
    expect(isEmojiQuery('herz')).toBe(true);
    expect(isEmojiQuery('-1')).toBe(true);
    expect(isEmojiQuery('')).toBe(false);
    expect(isEmojiQuery('1a')).toBe(false);
    expect(isEmojiQuery('he rz')).toBe(false);
    expect(colonMayOpenAfter('')).toBe(true);
    expect(colonMayOpenAfter(' ')).toBe(true);
    expect(colonMayOpenAfter('2')).toBe(false);
    expect(colonMayOpenAfter('s')).toBe(false);
    expect(endsInsideMarkdownCode('```\n```')).toBe(false);
  });

  it('lets Enter through after a single letter nobody moved away from', () => {
    expect(enterChoosesEmoji('D', false)).toBe(false);
    expect(enterChoosesEmoji('D', true)).toBe(true);
    expect(enterChoosesEmoji('he', false)).toBe(true);
  });
});
