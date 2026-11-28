import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@exocortex/contracts';

import { exactEmoji, loadEmojiCatalog, searchEmoji } from './emoji-catalog';

describe('the emoji catalogue (issue #269)', () => {
  it('has the whole set in every interface language', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const groups = await loadEmojiCatalog(locale);
      const chars = new Set(groups.flatMap((group) => group.emojis.map((entry) => entry.char)));
      expect(chars.size, locale).toBeGreaterThan(1800);
    }
  });

  it('finds an emoji by its German name and by its shortcode', async () => {
    const groups = await loadEmojiCatalog('de');
    expect(searchEmoji('herz', groups)[0]?.char).toBe('❤️');
    expect(searchEmoji('daumen', groups)[0]?.char).toBe('👍');
    expect(searchEmoji('tada', groups)[0]?.char).toBe('🎉');
    expect(searchEmoji('+1', groups)[0]?.char).toBe('👍️');
  });

  it('lists an emoji once, however the shortlist spells it', async () => {
    const groups = await loadEmojiCatalog('de');
    const thumbs = searchEmoji('daumen hoch', groups).filter((entry) =>
      entry.char.startsWith('👍'),
    );
    expect(thumbs).toHaveLength(1);
  });

  it('names the emoji in the reader’s language, the shortlist included', async () => {
    const english = await loadEmojiCatalog('en');
    expect(searchEmoji('heart', english)[0]?.char).toBe('❤️');
    const rocket = english[0]?.emojis.find((entry) => entry.char === '🚀');
    expect(rocket?.label).toBe('rocket');
    // The hand-written keywords stay beside the dataset's.
    expect(rocket?.keywords).toContain('deploy');

    const french = await loadEmojiCatalog('fr');
    expect(searchEmoji('cœur', french).map((entry) => entry.char)).toContain('❤️');
  });

  it('caps the list where it is asked to', async () => {
    const groups = await loadEmojiCatalog('de');
    expect(searchEmoji('a', groups, 30)).toHaveLength(30);
  });

  it('knows a shortcode typed out in full', async () => {
    const groups = await loadEmojiCatalog('de');
    expect(exactEmoji('tada', groups)?.char).toBe('🎉');
    expect(exactEmoji('Herz', groups)?.char).toBe('❤️');
    expect(exactEmoji('tad', groups)).toBeNull();
  });
});
