import { describe, expect, it } from 'vitest';

import { parseMarkdown, pruneForChat } from '@exocortex/editor';

import { splitSettledMarkdown, stabilizeStreamingTail } from './streaming-markdown';

function blocks(markdown: string): unknown[] {
  return pruneForChat(parseMarkdown(markdown, { assignBlockIds: false }).document).content ?? [];
}

describe('splitSettledMarkdown', () => {
  it('gives the input back when joined', () => {
    const text = 'Eins.\n\nZwei.\n\n- a\n- b\n\nDrei';
    const { settled, tail } = splitSettledMarkdown(text);
    expect([...settled, tail].join('')).toBe(text);
  });

  it('settles a paragraph once the next block has started', () => {
    expect(splitSettledMarkdown('Eins.\n\nZw')).toEqual({ settled: ['Eins.\n\n'], tail: 'Zw' });
  });

  it('settles nothing while the blank line has not been followed yet', () => {
    expect(splitSettledMarkdown('Eins.\n\n')).toEqual({ settled: [], tail: 'Eins.\n\n' });
  });

  it('keeps a list open for its next item and for an indented continuation', () => {
    expect(splitSettledMarkdown('- a\n\n- b').settled).toEqual([]);
    expect(splitSettledMarkdown('1. a\n\n   weiter').settled).toEqual([]);
    expect(splitSettledMarkdown('- a\n\nDanach').settled).toEqual(['- a\n\n']);
  });

  it('never cuts inside a fenced code block', () => {
    const text = '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nText';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: ['```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n'],
      tail: 'Text',
    });
    expect(splitSettledMarkdown('```\na\n\nb').settled).toEqual([]);
  });

  it('parses every settled piece the same on its own as inside the whole', () => {
    const text =
      '## Titel\n\nEin **Absatz**.\n\n- a\n- b\n\n1. eins\n2. zwei\n\n> Zitat\n\n```js\nx\n\ny\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nEnde.';
    const { settled, tail } = splitSettledMarkdown(text);
    const pieces = [...settled, tail].flatMap((piece) => blocks(piece));
    expect(pieces).toEqual(blocks(text));
  });
});

describe('stabilizeStreamingTail', () => {
  it('holds back a lone marker that would turn the line above into a heading', () => {
    expect(stabilizeStreamingTail('Ein Satz.\n-')).toBe('Ein Satz.\n');
    expect(stabilizeStreamingTail('Ein Satz.\n=')).toBe('Ein Satz.\n');
    expect(stabilizeStreamingTail('Ein Satz.\n1.')).toBe('Ein Satz.\n');
  });

  it('holds back an empty heading, quote or code fence', () => {
    expect(stabilizeStreamingTail('##')).toBe('');
    expect(stabilizeStreamingTail('Text\n>')).toBe('Text\n');
    expect(stabilizeStreamingTail('Text\n```pyt')).toBe('Text\n');
  });

  it('shows a list item as soon as it has words', () => {
    expect(stabilizeStreamingTail('- Ein')).toBe('- Ein');
  });

  it('drops a closing fence on its way in but keeps the code', () => {
    expect(stabilizeStreamingTail('```\nconst a = 1;\n``')).toBe('```\nconst a = 1;\n');
    expect(stabilizeStreamingTail('```\nconst a')).toBe('```\nconst a');
  });

  it('closes emphasis and code that already have content', () => {
    expect(stabilizeStreamingTail('Das ist **wich')).toBe('Das ist **wich**');
    expect(stabilizeStreamingTail('Das ist **wichtig ')).toBe('Das ist **wichtig** ');
    expect(stabilizeStreamingTail('Nimm `pnpm')).toBe('Nimm `pnpm`');
    expect(stabilizeStreamingTail('Ganz *kurs')).toBe('Ganz *kurs*');
  });

  it('drops a marker that has nothing after it yet', () => {
    expect(stabilizeStreamingTail('Das ist **')).toBe('Das ist ');
    expect(stabilizeStreamingTail('Nimm `')).toBe('Nimm ');
  });

  it('leaves balanced text, lists and multiplication alone', () => {
    expect(stabilizeStreamingTail('Ein **fertiger** Satz')).toBe('Ein **fertiger** Satz');
    expect(stabilizeStreamingTail('* Punkt\n* zwei')).toBe('* Punkt\n* zwei');
    expect(stabilizeStreamingTail('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(stabilizeStreamingTail('`a*b`')).toBe('`a*b`');
  });

  it('shows the words of a link that is still being written', () => {
    expect(stabilizeStreamingTail('Siehe [die Do')).toBe('Siehe die Do');
    expect(stabilizeStreamingTail('Siehe [die Doku](https://exa')).toBe('Siehe die Doku');
    expect(stabilizeStreamingTail('Siehe [[Mein')).toBe('Siehe [[Mein]]');
  });

  it('never changes a finished line', () => {
    expect(stabilizeStreamingTail('Ein Satz.\n')).toBe('Ein Satz.\n');
  });
});
