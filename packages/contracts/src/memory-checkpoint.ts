import { z } from 'zod';

import { memoryClientSchema, memoryProjectSchema } from './memory';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The pre-compaction checkpoint (issue #92).
 *
 * `capture` is the end of a session: it answers at once, a job distils the
 * transcript later, and nothing is promised. A checkpoint is the middle of one,
 * and it promises the opposite: the caller is about to throw the wording of its
 * own conversation away and may only do so once this deployment has written
 * something down. So this call is synchronous, it is idempotent, and it fails
 * loudly. Hermes' `checkpoint_required: true` turns that failure into "do not
 * compact", which is the whole point of the endpoint.
 */

/**
 * One message of the evidence about to be compacted away.
 *
 * A list rather than one blob, because the list is what makes a second
 * checkpoint cheap: Hermes compacts at turn 40 and again at turn 80, and the
 * second call carries the first call's messages again. Per-message digests let
 * the server distil only what is new. A blob could recognise nothing but an
 * exact retry, which is the one case that does not happen.
 */
export const memoryCheckpointMessageSchema = z.object({
  /** `user`, `assistant`, `tool`, `system` -- whatever the agent calls it. Provenance, not a branch. */
  role: z.string().trim().min(1).max(40),
  /** The message as text. The caller flattens its own tool results and attachments. */
  text: z.string().max(200_000),
});
export type MemoryCheckpointMessage = z.infer<typeof memoryCheckpointMessageSchema>;

/** Ceiling for one checkpoint's evidence, the same one `capture` puts on a transcript. */
export const MEMORY_CHECKPOINT_MAX_CHARS = 400_000;

export const memoryCheckpointRequestSchema = z
  .object({
    project: memoryProjectSchema,
    client: memoryClientSchema.default('other'),
    /**
     * The agent's own session id. Required here, unlike on `capture`: without
     * it there is nothing to recognise a second checkpoint of the same
     * conversation by, and the dedup this endpoint promises would be a lie.
     */
    sessionId: z.string().trim().min(1).max(200),
    messages: z.array(memoryCheckpointMessageSchema).min(1).max(2_000),
    /** What the caller believes the session is about. A hint for the model, not a title. */
    hint: z.string().trim().max(500).optional(),
    /**
     * When this part of the session happened. Defaults to now, which is right
     * for a live compaction; a replayed conversation sends the real one so the
     * note is dated by the work rather than by the replay.
     */
    occurredAt: isoDateTimeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const chars = value.messages.reduce((total, message) => total + message.text.length, 0);
    if (chars > MEMORY_CHECKPOINT_MAX_CHARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message: `The evidence of one checkpoint may not exceed ${MEMORY_CHECKPOINT_MAX_CHARS} characters`,
      });
    }
  });
export type MemoryCheckpointRequest = z.infer<typeof memoryCheckpointRequestSchema>;

export const memoryCheckpointResponseSchema = z.object({
  checkpointId: idSchema,
  sessionId: z.string(),
  /** The idempotency key this call resolved to. Stable for the same evidence. */
  digest: z.string(),
  /**
   * True when nothing new was written because this evidence was already
   * checkpointed. A success: the caller may compact.
   */
  deduplicated: z.boolean(),
  /** How many of the messages sent were new to this session. Zero on a repeat. */
  newMessages: z.number().int().nonnegative(),
  /**
   * The note that was written, or null when the model judged the evidence held
   * nothing worth keeping. Null is still a successful checkpoint: the judgement
   * was made and recorded, and nothing is gained by keeping the wording of a
   * session that said nothing.
   */
  documentId: idSchema.nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  tookMs: z.number().int().nonnegative(),
});
export type MemoryCheckpointResponse = z.infer<typeof memoryCheckpointResponseSchema>;
