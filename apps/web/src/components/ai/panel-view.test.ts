import { describe, expect, it } from 'vitest';

import { type AiConversationMessage } from '@exocortex/contracts';

import {
  buildCommandNotice,
  buildStreamingMessages,
  commandAnswersWithList,
  describeTranscript,
  liveSelectionOffer,
  resolvePageHandover,
  summaryFollows,
} from './panel-view';
import { appendDelta, EMPTY_STREAM, endTurn, startStream } from './stream-segments';

function message(
  id: string,
  role: AiConversationMessage['role'],
  content: string,
  runId: string | null,
): AiConversationMessage {
  return {
    id,
    conversationId: 'c',
    role,
    content,
    toolName: null,
    toolCallId: null,
    isSummary: false,
    superseded: false,
    runId,
    attachments: [],
    createdAt: '2026-11-26T00:00:00.000Z',
  };
}

describe('buildStreamingMessages', () => {
  it('is empty with nothing in flight and nothing left over', () => {
    expect(
      buildStreamingMessages({
        stream: EMPTY_STREAM,
        messages: [],
        activeRunId: null,
        conversationId: 'c',
      }),
    ).toEqual([]);
  });

  it('shows a bubble as soon as a run starts, before any text', () => {
    const bubbles = buildStreamingMessages({
      stream: startStream('r1'),
      messages: [],
      activeRunId: 'r1',
      conversationId: 'c',
    });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ id: 'streaming-r1-0', role: 'assistant', content: '' });
  });

  it('gives every turn its own bubble and drops the ones the transcript carries', () => {
    let stream = appendDelta(startStream('r1'), 'Ich lese nach.');
    stream = endTurn(stream);
    stream = appendDelta(stream, 'Hier ist');
    const live = { stream, activeRunId: 'r1', conversationId: 'c' };

    expect(buildStreamingMessages({ ...live, messages: [] }).map((m) => m.content)).toEqual([
      'Ich lese nach.',
      'Hier ist',
    ]);

    const stored = [
      message('q', 'user', 'Frage', null),
      message('a1', 'assistant', 'Ich lese nach.', 'r1'),
      message('t1', 'tool', 'Ergebnis', 'r1'),
    ];
    const bubbles = buildStreamingMessages({ ...live, messages: stored });
    // The turn being written keeps its identity while the one above is stored.
    expect(bubbles.map((m) => [m.id, m.content])).toEqual([['streaming-r1-1', 'Hier ist']]);
  });

  it('keeps the finished answer on screen until the transcript has it', () => {
    const stream = appendDelta(startStream('r1'), 'Fertig.');
    const done = { stream, activeRunId: null, conversationId: 'c' };
    expect(buildStreamingMessages({ ...done, messages: [] })).toHaveLength(1);
    expect(
      buildStreamingMessages({ ...done, messages: [message('a', 'assistant', 'Fertig.', 'r1')] }),
    ).toEqual([]);
  });
});

describe('buildCommandNotice', () => {
  it('is a system bubble that belongs to no run', () => {
    expect(buildCommandNotice('c', '/help …')).toMatchObject({
      conversationId: 'c',
      role: 'system',
      content: '/help …',
      runId: null,
    });
  });
});

describe('commandAnswersWithList', () => {
  it('keeps a bubble for the listing commands, even a one-line answer', () => {
    expect(commandAnswersWithList('help')).toBe(true);
    expect(commandAnswersWithList('tools')).toBe(true);
    expect(commandAnswersWithList('rules')).toBe(true);
  });

  it('sends a changed setting to the notice slot', () => {
    expect(commandAnswersWithList('model')).toBe(false);
    expect(commandAnswersWithList('clear')).toBe(false);
    expect(commandAnswersWithList('context')).toBe(false);
  });
});

describe('resolvePageHandover', () => {
  const selection = { documentId: 'p1', blockIds: ['b1'], text: 'Absatz' };

  it('keeps what belongs to the page the route is on', () => {
    expect(
      resolvePageHandover({
        documentId: 'p1',
        activeDatabaseView: { documentId: 'p1', viewId: 'v1' },
        handedOverSelection: selection,
      }),
    ).toEqual({ databaseViewId: 'v1', selection });
  });

  it('drops a view and a passage left over from another page', () => {
    expect(
      resolvePageHandover({
        documentId: 'p2',
        activeDatabaseView: { documentId: 'p1', viewId: 'v1' },
        handedOverSelection: selection,
      }),
    ).toEqual({ databaseViewId: null, selection: null });
  });
});

describe('liveSelectionOffer', () => {
  const live = { documentId: 'p1', blockIds: ['b1'], text: 'Absatz' };

  it('offers what is marked on the page the route is on', () => {
    expect(liveSelectionOffer({ documentId: 'p1', live, pending: null })).toBe(live);
  });

  it('offers nothing from another page, and nothing without a page', () => {
    expect(liveSelectionOffer({ documentId: 'p2', live, pending: null })).toBeNull();
    expect(liveSelectionOffer({ documentId: null, live, pending: null })).toBeNull();
  });

  it('offers nothing when that passage is already the one waiting to be sent', () => {
    expect(
      liveSelectionOffer({ documentId: 'p1', live, pending: { blockIds: ['b1'], text: 'Absatz' } }),
    ).toBeNull();
  });

  it('offers a different passage beside the one already handed over', () => {
    expect(
      liveSelectionOffer({
        documentId: 'p1',
        live,
        pending: { blockIds: ['b2'], text: 'Anderes' },
      }),
    ).toBe(live);
  });
});

describe('describeTranscript', () => {
  const base = {
    open: true,
    query: { pending: false, errored: false },
    messageCount: 0,
    commandNotice: null,
    streamingCount: 0,
  };

  it('introduces an empty conversation', () => {
    expect(describeTranscript(base)).toEqual({ loading: false, errored: false, showIntro: true });
  });

  it('is neither loading nor failed while no conversation is open', () => {
    expect(
      describeTranscript({ ...base, open: false, query: { pending: true, errored: true } }),
    ).toEqual({ loading: false, errored: false, showIntro: true });
  });

  it('hides the introduction once there is something to show', () => {
    expect(describeTranscript({ ...base, messageCount: 2 }).showIntro).toBe(false);
    expect(describeTranscript({ ...base, query: { pending: true, errored: false } })).toEqual({
      loading: true,
      errored: false,
      showIntro: false,
    });
  });
});

describe('summaryFollows', () => {
  const row = (superseded: boolean, isSummary = false) => ({ superseded, isSummary });

  it('finds the summary an automatic compaction wrote below the tail it kept', () => {
    // Retired, retired | kept, kept, summary: the boundary sits after index 1.
    const messages = [row(true), row(true), row(false), row(false), row(false, true)];
    expect(summaryFollows(messages, 2)).toBe(true);
  });

  it('finds the summary a requested compaction left as the only message in the context', () => {
    expect(summaryFollows([row(true), row(true), row(false, true)], 2)).toBe(true);
  });

  it('reads a /clear as cleared, even when an older summary was cleared with it', () => {
    const messages = [row(true), row(true, true), row(false), row(false)];
    expect(summaryFollows(messages, 2)).toBe(false);
  });

  it('stops at the next boundary instead of borrowing a later summary', () => {
    const messages = [row(true), row(false), row(true), row(false, true)];
    expect(summaryFollows(messages, 1)).toBe(false);
  });
});
