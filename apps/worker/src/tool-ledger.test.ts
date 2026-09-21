import { describe, expect, it } from 'vitest';

import { describeToolLoop, repeatHint, ToolCallLedger } from './tool-ledger';

function book(
  ledger: ToolCallLedger,
  name: string,
  argumentsJson: string,
  resultText: string,
  comparable = true,
): ReturnType<ToolCallLedger['record']> {
  return ledger.record({ name, argumentsJson, resultText, comparable });
}

describe('ToolCallLedger', () => {
  it('names the earlier call when the answer is the same one again', () => {
    const ledger = new ToolCallLedger();
    book(ledger, 'exo_search', '{"q":"Tumorambulanz"}', 'Ein Treffer');
    book(ledger, 'exo_page_read', '{"documentId":"a"}', 'Eine Seite');
    const third = book(ledger, 'exo_search', '{"q":"Tumorambulanz"}', 'Ein Treffer');

    expect(third).toEqual({ call: 3, repeatOf: 1 });
  });

  it('lets the same question through once its answer has changed', () => {
    const ledger = new ToolCallLedger();
    book(ledger, 'exo_project_build_status', '{"buildId":"b"}', 'läuft');
    const second = book(ledger, 'exo_project_build_status', '{"buildId":"b"}', 'fertig');
    const third = book(ledger, 'exo_project_build_status', '{"buildId":"b"}', 'fertig');

    // A run waiting for something is never refused while the something moves:
    // only the answer that stopped moving is refused.
    expect(second.repeatOf).toBeNull();
    expect(third.repeatOf).toBe(2);
  });

  it('reads two orderings of the same arguments as one question', () => {
    const ledger = new ToolCallLedger();
    book(ledger, 'exo_search', '{"q":"x","workspaceId":"w"}', 'Treffer');
    const second = book(ledger, 'exo_search', '{"workspaceId":"w","q":"x"}', 'Treffer');

    expect(second.repeatOf).toBe(1);
  });

  it('never calls a write a repeat, so the confirmation gate keeps working', () => {
    const ledger = new ToolCallLedger();
    book(ledger, 'exo_page_delete', '{"documentId":"a"}', 'Bestätigung nötig', false);
    const second = book(
      ledger,
      'exo_page_delete',
      '{"documentId":"a"}',
      'Bestätigung nötig',
      false,
    );

    expect(second.repeatOf).toBeNull();
  });

  it('counts calls and characters per tool, the biggest spender first', () => {
    const ledger = new ToolCallLedger();
    book(ledger, 'exo_search', '{"q":"a"}', 'x'.repeat(100));
    book(ledger, 'exo_search', '{"q":"b"}', 'y'.repeat(200));
    book(ledger, 'exo_search', '{"q":"a"}', 'x'.repeat(100));
    book(ledger, 'exo_page_read', '{"documentId":"a"}', 'z'.repeat(50));

    expect(ledger.tallies()).toEqual([
      { name: 'exo_search', calls: 3, repeats: 1, chars: 300 },
      { name: 'exo_page_read', calls: 1, repeats: 0, chars: 50 },
    ]);
  });
});

describe('repeatHint', () => {
  it('points at the earlier call and at the three ways to something new', () => {
    const hint = repeatHint({ name: 'exo_search', repeatOf: 3 });

    expect(hint).toContain('Aufruf 3');
    expect(hint).toContain('exo_page_block_read');
    expect(hint).toContain('exo_page_read');
  });
});

describe('describeToolLoop', () => {
  it('names the tools, their size and how much of it said nothing new', () => {
    const message = describeToolLoop({
      limit: 8,
      tallies: [
        { name: 'exo_search', calls: 14, repeats: 9, chars: 128_400 },
        { name: 'exo_page_read', calls: 4, repeats: 0, chars: 120_000 },
      ],
    });

    expect(message).toContain('8 Werkzeugrunden');
    expect(message).toContain('18 Aufrufe');
    expect(message).toContain('exo_search: 14 Aufrufe, 128.400 Zeichen, davon 9 ohne neuen Inhalt');
    expect(message).toContain('9 Aufrufe haben genau das geliefert');
    expect(message).toContain('exo_page_block_read');
  });

  it('leaves out the repetition sentence when nothing repeated', () => {
    const message = describeToolLoop({
      limit: 3,
      tallies: [{ name: 'exo_page_write', calls: 4, repeats: 0, chars: 40 }],
    });

    expect(message).not.toContain('ohne neuen Inhalt');
    expect(message).not.toContain('schon geliefert hatte');
  });

  it('lists five tools and counts the rest', () => {
    const message = describeToolLoop({
      limit: 6,
      tallies: Array.from({ length: 7 }, (_, index) => ({
        name: `exo_tool_${String(index)}`,
        calls: 7 - index,
        repeats: 0,
        chars: 10,
      })),
    });

    expect(message).toContain('exo_tool_4');
    expect(message).not.toContain('exo_tool_5');
    expect(message).toContain('und 2 weitere Werkzeuge');
  });

  it('says so when the limit stopped the run before a single call', () => {
    const message = describeToolLoop({ limit: 0, tallies: [] });

    expect(message).toContain('0 Werkzeugrunden');
    expect(message).toContain('kein einziger Werkzeugaufruf');
  });
});
