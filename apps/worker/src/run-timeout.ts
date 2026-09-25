import { type AiRunDiagnosis, type AiRunTimeoutArgs } from '@exocortex/contracts';

import { germanDiagnosis } from './diagnosis';

/** What ran out, and what the run had to show for the time it spent. */
export type RunTimeoutFacts = AiRunTimeoutArgs;

/**
 * Why the run ran out of time, in the words of what it was actually doing.
 *
 * The message this replaces said "Die KI hat zu lange gebraucht." and nothing
 * else, which leaves out the two facts that decide what to do next: which of
 * the two limits ran out, and that the time went into thinking rather than
 * into writing. A run at thinking level `maximal` on a model that answers the
 * same question in 79 seconds at `hoch` is not a run that needs a higher
 * limit, and the panel is where that has to be said, because the level is set
 * beside the model picker and not in the administration. Stored as facts; the
 * words are the `diagnostics` namespace's, in each reader's language
 * (issue #98).
 */
export function runTimeoutDiagnosis(facts: RunTimeoutFacts): AiRunDiagnosis {
  return { key: 'runTimeout', args: { ...facts } };
}

/** The same diagnosis in German, as `AiRun.errorDetail` stores it. */
export function describeRunTimeout(facts: RunTimeoutFacts): string {
  return germanDiagnosis(runTimeoutDiagnosis(facts));
}
