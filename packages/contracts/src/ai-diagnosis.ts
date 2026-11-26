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

/**
 * `ai_stream_interrupted` / `ai_empty_answer`: a turn ended without an answer
 * and without a tool call. Either the provider closed the stream before it
 * said the answer was finished, or it said so with nothing in it. Before this
 * existed both looked like a completed run with an empty bubble.
 */
export const aiRunIncompleteTurnArgsSchema = z.object({
  /** `true` when no finish reason arrived, `false` when the provider finished with nothing. */
  interrupted: z.boolean(),
  model: z.string(),
  effort: aiReasoningLevelSchema,
  /** How often the same turn was asked for; an empty turn is retried before the run gives up. */
  attempts: z.number().int().positive(),
  /** Characters of the answer that had streamed before the last attempt broke off. */
  turnChars: z.number().int().nonnegative(),
  /** Whether the provider had said it was thinking in the last attempt. */
  sawReasoning: z.boolean(),
  /** Tool rounds the run got through before the turn that broke. */
  toolIterations: z.number().int().nonnegative(),
});
export type AiRunIncompleteTurnArgs = z.infer<typeof aiRunIncompleteTurnArgsSchema>;

/**
 * `ai_no_eligible_provider`: nobody would serve the model. Three causes ask
 * for three different remedies, and before this existed all of them read
 * "the answer could not be produced":
 *
 * - `size`: the request is larger than any provider of the model accepts,
 *   decided here from the registry before anything was sent.
 * - `account`: the provider refused every endpoint because of the settings
 *   of the account the key belongs to (guardrails, data policy). Only the
 *   owner of that account can change it, which is why `ownKey` says whose.
 * - `unknown`: the provider refused the endpoints without naming the
 *   account, which is a stale endpoint snapshot more often than not.
 */
export const aiRunNoEligibleProviderArgsSchema = z.object({
  cause: z.enum(['size', 'account', 'unknown']),
  model: z.string(),
  /** Whether the workspace's own key made the request, rather than the deployment's. */
  ownKey: z.boolean(),
});
export type AiRunNoEligibleProviderArgs = z.infer<typeof aiRunNoEligibleProviderArgsSchema>;

/**
 * The provider refused the key itself (issue #225). Before this existed a
 * rejected or empty key read "the AI provider is currently unavailable",
 * which sends the reader to wait for an outage that is not there.
 *
 * - `invalid`: the key is unknown, revoked or disabled (HTTP 401).
 * - `credits`: the account behind it, or a limit set on the key, has no
 *   money left for this request (HTTP 402).
 *
 * `ownKey` says whose key it was, because only its owner can fix it, and the
 * run is never handed to another key instead: nobody else pays for it.
 */
export const aiRunKeyRefusedArgsSchema = z.object({
  reason: z.enum(['invalid', 'credits']),
  /** The provider that refused, `openrouter` or a subscription preset such as `cline`. */
  provider: z.string(),
  model: z.string(),
  /** Whether the workspace's own key made the request, rather than the deployment's. */
  ownKey: z.boolean(),
});
export type AiRunKeyRefusedArgs = z.infer<typeof aiRunKeyRefusedArgsSchema>;

export const aiRunDiagnosisSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('toolLoop'), args: aiRunToolLoopArgsSchema }),
  z.object({ key: z.literal('runTimeout'), args: aiRunTimeoutArgsSchema }),
  z.object({ key: z.literal('incompleteTurn'), args: aiRunIncompleteTurnArgsSchema }),
  z.object({ key: z.literal('noEligibleProvider'), args: aiRunNoEligibleProviderArgsSchema }),
  z.object({ key: z.literal('keyRefused'), args: aiRunKeyRefusedArgsSchema }),
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
