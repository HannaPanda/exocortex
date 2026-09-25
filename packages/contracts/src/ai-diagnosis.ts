import { z } from 'zod';

import { aiReasoningLevelSchema } from './ai-models';

/**
 * Why a run ended without an answer, as facts rather than as a sentence
 * (issue #118, ADR-059; issue #98, ADR-062).
 *
 * The worker stores a key and its arguments on `ai_run`, and every reader
 * renders them in its own language through the `diagnostics` namespace: the
 * browser in the viewer's, the API in the requester's. The German rendering
 * is still written to `errorDetail` beside them, for a row older than the
 * columns and for a reader that does not know a key yet.
 */

/** What one tool cost the run; the ledger keeps one per tool. */
export const aiRunToolTallySchema = z.object({
  name: z.string(),
  calls: z.number().int().nonnegative(),
  /** Calls that answered exactly what an earlier call had already answered. */
  repeats: z.number().int().nonnegative(),
  /** Characters this tool put into the context, the repeats not counted. */
  chars: z.number().int().nonnegative(),
});
export type AiRunToolTally = z.infer<typeof aiRunToolTallySchema>;

/** `ai_tool_limit_exceeded`: the limit and what the run spent its calls on. */
export const aiRunToolLoopArgsSchema = z.object({
  limit: z.number().int().nonnegative(),
  /** Most-used first, every tool the run called. */
  tallies: z.array(aiRunToolTallySchema),
});
export type AiRunToolLoopArgs = z.infer<typeof aiRunToolLoopArgsSchema>;

/** `ai_timeout`: which limit ran out, and what the run had to show for the time. */
export const aiRunTimeoutArgsSchema = z.object({
  /** `turn` is one model answer (`ai.timeoutMs`), `run` the whole run (`ai.maxRunMs`). */
  limit: z.enum(['turn', 'run']),
  limitMs: z.number().int().nonnegative(),
  model: z.string(),
  /** The thinking level this run asked the provider for. */
  effort: aiReasoningLevelSchema,
  /** Characters of the answer that had streamed when the limit hit. */
  turnChars: z.number().int().nonnegative(),
  /** Whether the provider had said it was thinking before it went quiet. */
  sawReasoning: z.boolean(),
  /** Tool rounds the run got through before it ran out. */
  toolIterations: z.number().int().nonnegative(),
});
export type AiRunTimeoutArgs = z.infer<typeof aiRunTimeoutArgsSchema>;

export const aiRunDiagnosisSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('toolLoop'), args: aiRunToolLoopArgsSchema }),
  z.object({ key: z.literal('runTimeout'), args: aiRunTimeoutArgsSchema }),
]);
export type AiRunDiagnosis = z.infer<typeof aiRunDiagnosisSchema>;
export type AiRunDiagnosisKey = AiRunDiagnosis['key'];

/**
 * The wire and column shape of the arguments: an open object, so a reader
 * that is older than a key can still carry it and fall back to `errorDetail`.
 */
export const aiRunDiagnosisArgsSchema = z.record(z.string(), z.unknown());

/**
 * Key and arguments as one checked diagnosis, or `null` when there is none or
 * this reader does not know it. `null` means: show `errorDetail`.
 */
export function parseAiRunDiagnosis(key: string | null, args: unknown): AiRunDiagnosis | null {
  if (key === null) return null;
  const parsed = aiRunDiagnosisSchema.safeParse({ key, args });
  return parsed.success ? parsed.data : null;
}
