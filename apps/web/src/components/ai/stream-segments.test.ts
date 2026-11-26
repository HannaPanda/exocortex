import { describe, expect, it } from 'vitest';

import {
  appendDelta,
  currentTurnText,
  endTurn,
  pendingSegments,
  replaceCurrentTurn,
  startStream,
} from './stream-segments';

describe('stream segments', () => {
  it('starts a new segment only after a turn that wrote something', () => {
    let stream = endTurn(startStream('r'));
    expect(stream.segments).toEqual([]);
    stream = appendDelta(stream, 'Eins');
    stream = endTurn(endTurn(stream));
    stream = appendDelta(stream, 'Zwei');
    expect(stream.segments).toEqual(['Eins', 'Zwei']);
    expect(currentTurnText(stream)).toBe('Zwei');
  });

  it('repairs the turn in flight from the worker and, before it wrote, the one before', () => {
    let stream = appendDelta(startStream('r'), 'Ei');
    expect(replaceCurrentTurn(stream, 'Eins').segments).toEqual(['Eins']);
    stream = endTurn(stream);
    expect(replaceCurrentTurn(stream, 'Eins').segments).toEqual(['Eins', '']);
    expect(replaceCurrentTurn(stream, 'Neu').segments).toEqual(['Ei', 'Neu']);
    expect(replaceCurrentTurn(stream, '').segments).toEqual(['Ei', '']);
  });

  it('matches stored answers in order, so a repeated sentence is not lost', () => {
    let stream = appendDelta(startStream('r'), 'Moment.');
    stream = appendDelta(endTurn(stream), 'Moment.');
    expect(pendingSegments(stream, ['Moment.'], true)).toEqual([{ index: 1, text: 'Moment.' }]);
  });

  it('keeps the empty turn in flight only while the run is live', () => {
    const stream = endTurn(appendDelta(startStream('r'), 'Eins'));
    expect(pendingSegments(stream, ['Eins'], true)).toEqual([{ index: 1, text: '' }]);
    expect(pendingSegments(stream, ['Eins'], false)).toEqual([]);
  });
});
