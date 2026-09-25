import { describe, expect, it } from 'vitest';

import {
  buildCommandNotice,
  buildStreamingMessage,
  describeTranscript,
  resolvePageHandover,
} from './panel-view';

describe('buildStreamingMessage', () => {
  it('is null with nothing in flight and nothing left over', () => {
    expect(buildStreamingMessage({ streamText: '', activeRunId: null, conversationId: 'c' })).toBe(
      null,
    );
  });

  it('shows a bubble as soon as a run starts, before any text', () => {
    const message = buildStreamingMessage({
      streamText: '',
      activeRunId: 'r1',
      conversationId: 'c',
    });
    expect(message).toMatchObject({ id: 'streaming-r1', role: 'assistant', runId: 'r1' });
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

describe('describeTranscript', () => {
  const base = {
    open: true,
    query: { pending: false, errored: false },
    messageCount: 0,
    commandNotice: null,
    streamingMessage: null,
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
