/**
 * The text of a run that is still arriving, kept per turn (issue #242).
 *
 * A run that calls tools writes in several turns, and the worker stores each
 * turn's text as a message of its own, with the tool results between them.
 * The panel used to glue every turn's text into one bubble and only learned
 * the real shape when the run was over and the transcript was reloaded: the
 * text was split apart, results appeared in between, and what had been read
 * jumped. Kept per turn, the live bubbles have the shape the stored messages
 * will have, and a turn the transcript already carries is not shown twice.
 */
export interface StreamSegments {
  /** The run the text belongs to; kept after it ends until the transcript has it. */
  runId: string | null;
  /** One entry per turn that wrote; the last one is the turn being written. */
  segments: readonly string[];
}

export const EMPTY_STREAM: StreamSegments = { runId: null, segments: [] };

export function startStream(runId: string): StreamSegments {
  return { runId, segments: [] };
}

/** A fragment of the turn being written. */
export function appendDelta(stream: StreamSegments, delta: string): StreamSegments {
  const segments = stream.segments.length === 0 ? [''] : [...stream.segments];
  segments[segments.length - 1] += delta;
  return { ...stream, segments };
}

/**
 * A tool call was made: whatever is written next is the next turn's. Only a
 * turn that wrote something leaves a segment behind.
 */
export function endTurn(stream: StreamSegments): StreamSegments {
  const last = stream.segments[stream.segments.length - 1];
  if (last === undefined || last.length === 0) return stream;
  return { ...stream, segments: [...stream.segments, ''] };
}

/**
 * The text the worker reports for the turn in flight, which replaces the
 * locally stitched one after a gap in the fragments (issue #6). Before the
 * new turn has written anything, the worker still reports the previous one.
 */
export function replaceCurrentTurn(stream: StreamSegments, text: string): StreamSegments {
  if (text.length === 0) return stream;
  const segments = [...stream.segments];
  const last = segments.length - 1;
  if (last < 0) return { ...stream, segments: [text] };
  if (segments[last] === '' && last > 0 && text.startsWith(segments[last - 1]!)) {
    segments[last - 1] = text;
  } else {
    segments[last] = text;
  }
  return { ...stream, segments };
}

/** The turn being written, for the pulse that says whether text is arriving. */
export function currentTurnText(stream: StreamSegments): string {
  return stream.segments[stream.segments.length - 1] ?? '';
}

/**
 * The segments the transcript does not carry yet, each with its position in
 * the run (which keeps its bubble's identity while earlier ones drop away).
 * A segment is taken as stored when the run's next stored answer says the
 * same, in order; the turn being written is kept while the run is live, even
 * empty, because that bubble is where the cursor stands.
 */
export function pendingSegments(
  stream: StreamSegments,
  storedTexts: readonly string[],
  live: boolean,
): { index: number; text: string }[] {
  const pending: { index: number; text: string }[] = [];
  let stored = 0;
  stream.segments.forEach((text, index) => {
    const isCurrent = index === stream.segments.length - 1;
    if (stored < storedTexts.length && text.trim() === storedTexts[stored]!.trim()) {
      stored += 1;
      return;
    }
    if (text.length === 0 && !(live && isCurrent)) return;
    pending.push({ index, text });
  });
  if (live && stream.segments.length === 0) pending.push({ index: 0, text: '' });
  return pending;
}
