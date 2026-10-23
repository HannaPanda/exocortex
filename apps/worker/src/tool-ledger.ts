import { createHash } from 'node:crypto';

import { type AiRunDiagnosis, type AiRunToolTally } from '@exocortex/contracts';

import { germanDiagnosis } from './diagnosis';

/**
 * What one tool cost this run (issue #118, ADR-059).
 *
 * Kept per tool rather than per call, because the diagnosis this feeds is
 * about a pattern: fourteen searches is a loop, fourteen different tools is a
 * complicated task. `chars` is the size half of it -- the run that named this
 * issue spent 1.36 million input tokens, and that came out of what the tools
 * returned, not out of what the model wrote.
 */
export type ToolCallTally = AiRunToolTally;

/** Where a call landed: its number in the run, and the earlier one it repeats. */
export interface LedgerVerdict {
  /** 1-based position of this call among all of the run's tool calls. */
  call: number;
  /** The earlier call that already answered exactly this, or `null`. */
  repeatOf: number | null;
  /**
   * For a write: how many times this run has made it with the same
   * arguments and got the same answer, this call included. 0 for a read.
   */
  sameWrites: number;
}

/**
 * The identical write at which the run is told it is going in circles
 * (issue #206). Not the second: the confirmation gate asks for every write
 * twice, so two identical writes are the gate working.
 */
export const WRITE_REPEAT_HINT_AT = 3;

interface AnsweredCall {
  call: number;
  hash: string;
}

interface Counter {
  calls: number;
  repeats: number;
  chars: number;
}

/**
 * Remembers what this run has already asked and already been told.
 *
 * The duplicate guard the issue asks for is described there as "same tool,
 * same arguments, no write in between, same page revision". All four of those
 * are conditions for one thing: that the answer would be the same. So that is
 * what is compared -- the answer itself, by hash -- and the four conditions
 * come out of it for free and without a way to get them wrong.
 *
 * It matters that it is this way round rather than a rule about arguments. A
 * run may legitimately call the same tool with the same arguments over and
 * over: a build it started, a render it is waiting for, an activity feed. A
 * rule about arguments would have to know which tools those are, would be
 * wrong about the next one somebody adds, and would break a run that is
 * waiting for something. Comparing answers refuses nothing that could still
 * tell the model something new: if the build moved on, the answer moved with
 * it.
 */
export class ToolCallLedger {
  private readonly answered = new Map<string, AnsweredCall>();
  private readonly writes = new Map<string, { hash: string; times: number }>();
  private readonly counters = new Map<string, Counter>();
  private callCount = 0;

  /**
   * Books one finished call and says whether its answer is one the run has.
   *
   * `comparable` is false for a write, for a refusal and for an error: a write
   * is allowed to be repeated (the confirmation gate is built on exactly
   * that), and two identical failures are two failures rather than a loop.
   *
   * A write is still counted (`write`), because it can loop too: on
   * 2026-10-23 a run renamed a page fifteen times to the title it already had,
   * each time with the same answer, and nothing said so (issue #206). It is
   * never swapped for a hint, only reported, so the gate keeps its second call.
   */
  record(input: {
    name: string;
    argumentsJson: string;
    resultText: string;
    comparable: boolean;
    /** A successful write: counted for `sameWrites`, never compared away. */
    write?: boolean;
  }): LedgerVerdict {
    this.callCount += 1;
    const call = this.callCount;
    const counter = this.counterFor(input.name);
    counter.calls += 1;

    const key = `${input.name}\u0000${argumentKey(input.argumentsJson)}`;
    const hash = createHash('sha256').update(input.resultText).digest('hex');

    if (!input.comparable) {
      if (input.write !== true) return { call, repeatOf: null, sameWrites: 0 };
      const before = this.writes.get(key);
      const times = before !== undefined && before.hash === hash ? before.times + 1 : 1;
      this.writes.set(key, { hash, times });
      if (times >= WRITE_REPEAT_HINT_AT) counter.repeats += 1;
      return { call, repeatOf: null, sameWrites: times };
    }

    const earlier = this.answered.get(key);
    if (earlier !== undefined && earlier.hash === hash) {
      counter.repeats += 1;
      return { call, repeatOf: earlier.call, sameWrites: 0 };
    }

    this.answered.set(key, { call, hash });
    counter.chars += input.resultText.length;
    return { call, repeatOf: null, sameWrites: 0 };
  }

  /** The most-used tools first, so the diagnosis leads with what the run spent itself on. */
  tallies(): ToolCallTally[] {
    return [...this.counters.entries()]
      .map(([name, counter]) => ({ name, ...counter }))
      .sort((left, right) => right.calls - left.calls || right.chars - left.chars);
  }

  private counterFor(name: string): Counter {
    const existing = this.counters.get(name);
    if (existing !== undefined) return existing;
    const created: Counter = { calls: 0, repeats: 0, chars: 0 };
    this.counters.set(name, created);
    return created;
  }
}

/**
 * The arguments in a form two equal calls agree on.
 *
 * Key order is the model's, not the payload's meaning: `{a,b}` and `{b,a}` are
 * the same question asked twice. Anything that is not JSON is compared as the
 * string it arrived as, because a call whose arguments do not parse never
 * reaches a tool anyway.
 */
function argumentKey(argumentsJson: string): string {
  try {
    return stableJson(JSON.parse(argumentsJson) as unknown);
  } catch {
    return argumentsJson;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What a repeated call is told instead of the answer it already has.
 *
 * Not an error: nothing failed, and calling it one would invite a retry, which
 * is the behaviour this replaces. It is a statement of fact plus the three
 * ways to ask something the run does not already know -- naming them, because
 * the failing run did not repeat itself out of laziness, it repeated itself
 * because it did not know there was another way in.
 */
export function repeatHint(input: { name: string; repeatOf: number }): string {
  return [
    `${input.name} antwortet hier Zeichen für Zeichen dasselbe wie Aufruf ${String(input.repeatOf)} ` +
      'in diesem Lauf. Die Antwort steht dort und wird deshalb nicht wiederholt.',
    'Seither hat sich nichts geändert, ein weiterer gleicher Aufruf ändert das auch nicht. ' +
      'Es gibt drei Wege zu etwas Neuem:',
    '- exo_search nennt bei einem semantischen Treffer den Abschnitt samt Blockkennung.',
    '- exo_page_read antwortet bei einer großen Seite mit einer Karte; wähle daraus einen Abschnitt.',
    '- exo_page_block_read öffnet genau einen Abschnitt über seine Blockkennung.',
  ].join('\n');
}

/**
 * What a write is told on top of its answer once it has made the same change
 * with the same answer three times (issue #206).
 *
 * Appended, never instead: the change happened, and the model has to read
 * that it did. The point is the second half, because the run that named this
 * did not loop for want of trying. It wanted to archive, had no archive tool
 * and reached for the closest thing it had.
 */
export function writeRepeatHint(input: { name: string; times: number }): string {
  return [
    `Hinweis: ${input.name} ist jetzt ${String(input.times)}-mal mit denselben ` +
      'Argumenten aufgerufen worden und hat jedes Mal dasselbe geantwortet. Ein weiterer gleicher ' +
      'Aufruf ändert nichts.',
    'Willst du eigentlich etwas anderes erreichen (zum Beispiel archivieren, löschen oder ' +
      'verschieben), fehlt dir wahrscheinlich das passende Werkzeug: exo_toolbox nennt die ' +
      'übrigen Bereiche und schaltet einen davon frei.',
  ].join('\n');
}

/**
 * Why the run ran out of tool calls, in the words of what it actually did.
 *
 * The message this replaces said "Reached the tool iteration limit of 8" and
 * nothing else, which is the one fact the person already had. What they could
 * not see is that fourteen of the twenty calls were the same search reworded,
 * and that is what decides whether the answer is a higher limit (it is not) or
 * a different way in. Stored as facts; the words are the `diagnostics`
 * namespace's, in each reader's language (issue #98).
 */
export function toolLoopDiagnosis(input: {
  limit: number;
  tallies: readonly ToolCallTally[];
}): AiRunDiagnosis {
  return {
    key: 'toolLoop',
    args: { limit: input.limit, tallies: input.tallies.map((tally) => ({ ...tally })) },
  };
}

/** The same diagnosis in German, as `AiRun.errorDetail` stores it. */
export function describeToolLoop(input: {
  limit: number;
  tallies: readonly ToolCallTally[];
}): string {
  return germanDiagnosis(toolLoopDiagnosis(input));
}
