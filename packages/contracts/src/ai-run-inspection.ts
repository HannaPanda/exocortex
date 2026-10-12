import { z } from 'zod';

import { aiRunSchema, aiRunStatusSchema } from './ai';
import { contentOriginSchema } from './ai-trust';
import { attentionKindSchema, attentionStatusSchema } from './attention';
import { changesetStatusSchema } from './changesets';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * What a run did and what it was built from (issue #145, ADR-073).
 *
 * Two halves. The worker records a run's steps as `AiRunEvent` rows while it
 * happens; the API reads them back, joins in what other tables already know
 * about the run (a human checkpoint it raised, a change it proposed, the run
 * it was carried on in) and answers with one timeline.
 *
 * Every field below is an id, a count, a size, a name, a duration or an
 * outcome. Never a prompt, a message, a tool result or the text of a page:
 * the observability rule for spans (`docs/observability.md`) holds here too,
 * and it is what lets the timeline outlive the retention sweep that empties
 * a run's texts.
 */

const count = z.number().int().nonnegative();

/**
 * The parts a run's prompt is made of, in the order it is assembled.
 *
 * `conversation_*` split the transcript by who wrote it; `conversation_summary`
 * is what an earlier compaction left in place of the messages it summarised.
 * `tool_schemas` is the catalogue the first turn was offered, which travels in
 * front of every exchange without being a message at all (issue #121).
 */
export const AI_RUN_CONTEXT_SECTIONS = [
  'base_prompt',
  'formatting',
  'trust_rules',
  'always_rules',
  'on_demand_rules',
  'open_page',
  'pinned_sources',
  'closing',
  'agent_role',
  'write_mode',
  'images',
  'conversation_summary',
  'conversation_user',
  'conversation_assistant',
  'conversation_tool',
  'tool_schemas',
] as const;
export const aiRunContextSectionKeySchema = z.enum(AI_RUN_CONTEXT_SECTIONS);
export type AiRunContextSectionKey = z.infer<typeof aiRunContextSectionKeySchema>;

export const AI_RUN_CONTEXT_SOURCE_KINDS = [
  'page',
  'rule',
  'database_view',
  'saved_query',
  'attachment_images',
] as const;
export const aiRunContextSourceKindSchema = z.enum(AI_RUN_CONTEXT_SOURCE_KINDS);

/**
 * How a source reached the prompt: named only (`reference`), with its text
 * (`embedded`), or for the open page, as a pointer or with its content.
 */
export const aiRunContextSourceModeSchema = z.enum(['reference', 'embedded', 'pointer', 'content']);

/** One concrete thing a section was built from, as recorded. */
export const aiRunContextSourceSchema = z.object({
  kind: aiRunContextSourceKindSchema,
  documentId: idSchema.nullable(),
  databaseViewId: idSchema.nullable(),
  savedQueryId: idSchema.nullable(),
  mode: aiRunContextSourceModeSchema.nullable(),
  /** Characters it put into the prompt. */
  chars: count,
  /** What it would have put there without the budget; null where no budget applied. */
  fullChars: count.nullable(),
  truncated: z.boolean(),
  /** Where its text came from (ADR-030). */
  origin: contentOriginSchema,
});
export type AiRunContextSource = z.infer<typeof aiRunContextSourceSchema>;

export const aiRunContextSectionSchema = z.object({
  key: aiRunContextSectionKeySchema,
  chars: count,
  /** Estimated with the same arithmetic the route planner uses, not counted by a tokenizer. */
  estimatedTokens: count,
  /** Messages, rule pages or sources it holds, where counting them says something. */
  items: count.nullable(),
  truncated: z.boolean(),
  sources: z.array(aiRunContextSourceSchema),
});
export type AiRunContextSection = z.infer<typeof aiRunContextSectionSchema>;

/** The stored payload of each event kind. */
export const aiRunContextEventDataSchema = z.object({
  sections: z.array(aiRunContextSectionSchema),
});

export const aiRunCompactionEventDataSchema = z.object({
  /** Messages folded into the summary. */
  summarizedMessages: count,
  /** `prepare` before the first turn, `route` when no provider could take a later one. */
  trigger: z.enum(['prepare', 'route']),
});

export const aiRunTurnEventDataSchema = z.object({
  index: z.number().int().positive(),
  /** The model that answered, which differs from the run's for an alias. */
  model: z.string(),
  /** The upstream provider that served the turn, when the gateway said. */
  servedBy: z.string().nullable(),
  /**
   * The eXocortex provider that answered (`openrouter`, `cline`), which
   * differs from the run's when a subscription fell back (issue #187). Absent
   * on turns recorded before it was kept.
   */
  provider: z.string().nullable().optional(),
  /** Milliseconds to the first fragment of the answer; absent when not streamed or not measured. */
  firstTokenMs: count.nullable().optional(),
  /** How many providers the route plan allowed; null when the model had no endpoint snapshot. */
  eligibleProviders: count.nullable(),
  finishReason: z.string(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  cachedInputTokens: count.nullable(),
  costMicroUsd: count.nullable(),
  toolCalls: count,
  /** Whether the model thought before answering. The thinking itself is never kept. */
  reasoned: z.boolean(),
  outputChars: count,
  failureCode: z.string().nullable(),
});

export const AI_RUN_TOOL_CALL_STATUSES = [
  'succeeded',
  'failed',
  'refused',
  /** Not executed: an earlier call of the same turn paused the run on a question. */
  'skipped',
  /** Never executed: the provider did not deliver it whole. */
  'undelivered',
] as const;
export const aiRunToolCallStatusSchema = z.enum(AI_RUN_TOOL_CALL_STATUSES);

export const aiRunToolCallEventDataSchema = z.object({
  /** The tool round it arrived in (`AiRun.toolIterations`). */
  iteration: count,
  toolName: z.string(),
  status: aiRunToolCallStatusSchema,
  /** What it touched, as the catalogue names it (`document:<id>`), never its arguments. */
  target: z.string().nullable(),
  /** Characters its answer added to the context. */
  resultChars: count,
  /** The answer was cut at the loop's cap before it reached the model. */
  resultTruncated: z.boolean(),
  /** Foreign text this call brought into the run (ADR-030), null for the deployment's own. */
  untrustedOrigin: contentOriginSchema.nullable(),
  /** It answered exactly what the same call answered earlier in the run (ADR-059). */
  repeated: z.boolean(),
  /** It raised a blocking human checkpoint and paused the run (ADR-068). */
  pausedRun: z.boolean(),
});

export const aiRunTruncationEventDataSchema = z.object({
  attempt: z.number().int().positive(),
  /** A tool call was cut mid-arguments, rather than a text answer mid-sentence. */
  toolCall: z.boolean(),
});

export const aiRunEventDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), data: aiRunContextEventDataSchema }),
  z.object({ kind: z.literal('compaction'), data: aiRunCompactionEventDataSchema }),
  z.object({ kind: z.literal('turn'), data: aiRunTurnEventDataSchema }),
  z.object({ kind: z.literal('tool_call'), data: aiRunToolCallEventDataSchema }),
  z.object({ kind: z.literal('truncation_retry'), data: aiRunTruncationEventDataSchema }),
]);
export type AiRunEventData = z.infer<typeof aiRunEventDataSchema>;
export type AiRunEventKind = AiRunEventData['kind'];

/**
 * Upper bound on stored events per run. A run is bounded by its tool limit
 * already; this is the floor under a misconfiguration, and the inspector says
 * when it was reached rather than showing a timeline that silently stops.
 */
export const AI_RUN_EVENT_LIMIT = 600;

/* -------------------------------------------------------------------------- */
/* What the API answers with                                                  */
/* -------------------------------------------------------------------------- */

/** A source as read back: the recorded facts plus the title the reader may see. */
export const aiRunInspectionSourceSchema = aiRunContextSourceSchema.extend({
  /** Null when the page is gone, or lies outside what the reader may open. */
  title: z.string().nullable(),
});

export const aiRunInspectionSectionSchema = aiRunContextSectionSchema.extend({
  sources: z.array(aiRunInspectionSourceSchema),
});

const entryBase = {
  at: isoDateTimeSchema,
  durationMs: count.nullable(),
};

export const aiRunTimelineEntrySchema = z.discriminatedUnion('kind', [
  z.object({ ...entryBase, kind: z.literal('created') }),
  z.object({ ...entryBase, kind: z.literal('started') }),
  z.object({
    ...entryBase,
    kind: z.literal('context'),
    chars: count,
    estimatedTokens: count,
  }),
  z.object({
    ...entryBase,
    kind: z.literal('compaction'),
    ...aiRunCompactionEventDataSchema.shape,
  }),
  z.object({ ...entryBase, kind: z.literal('turn'), ...aiRunTurnEventDataSchema.shape }),
  z.object({
    ...entryBase,
    kind: z.literal('tool_call'),
    ...aiRunToolCallEventDataSchema.shape,
    /** The target page's title, when the target is one the reader may open. */
    targetTitle: z.string().nullable(),
  }),
  z.object({
    ...entryBase,
    kind: z.literal('truncation_retry'),
    ...aiRunTruncationEventDataSchema.shape,
  }),
  z.object({
    ...entryBase,
    kind: z.literal('attention_raised'),
    attentionItemId: idSchema,
    attentionKind: attentionKindSchema,
    title: z.string(),
    blocking: z.boolean(),
  }),
  z.object({
    ...entryBase,
    kind: z.literal('attention_settled'),
    attentionItemId: idSchema,
    status: attentionStatusSchema,
  }),
  z.object({
    ...entryBase,
    kind: z.literal('changeset'),
    changesetId: idSchema,
    title: z.string(),
    status: changesetStatusSchema,
  }),
  z.object({
    ...entryBase,
    kind: z.literal('work_checkpoint'),
    checkpointId: idSchema,
    trigger: z.string(),
  }),
  /** This run carries on an earlier one that paused on a question. */
  z.object({ ...entryBase, kind: z.literal('resumed_from'), runId: idSchema }),
  /** The answer to this run's question carried the work on in another run. */
  z.object({ ...entryBase, kind: z.literal('resumed_as'), runId: idSchema }),
  z.object({
    ...entryBase,
    kind: z.literal('finished'),
    status: aiRunStatusSchema,
    errorCode: z.string().nullable(),
  }),
]);
export type AiRunTimelineEntry = z.infer<typeof aiRunTimelineEntrySchema>;

export const aiRunInspectionSchema = z.object({
  run: aiRunSchema,
  /** Where the logs and the trace of this run are, for whoever runs the deployment. */
  trace: z.object({
    correlationId: z.string().nullable(),
    traceId: z.string().nullable(),
  }),
  /** False for a run from before the timeline was recorded: only the joined entries exist. */
  recorded: z.boolean(),
  /** The run hit `AI_RUN_EVENT_LIMIT`; later steps were not recorded. */
  eventsCapped: z.boolean(),
  summary: z.object({
    durationMs: count.nullable(),
    turns: count,
    toolCalls: count,
    failedToolCalls: count,
    /** Upstream providers that served a turn, in the order they first did. */
    providers: z.array(z.string()),
    /** Turns served by a different provider than the turn before (a gateway fallback or a re-plan). */
    providerSwitches: count,
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    cachedInputTokens: count.nullable(),
    /** Cost as the provider reported it. */
    providerCostMicroUsd: count.nullable(),
    /** Cost from the price list, only where the provider reported none. */
    estimatedCostMicroUsd: count.nullable(),
  }),
  /** What the prompt was built from before the first turn; null when it was not recorded. */
  context: z
    .object({
      chars: count,
      estimatedTokens: count,
      sections: z.array(aiRunInspectionSectionSchema),
    })
    .nullable(),
  /** What tool answers added to the context while the run went on, by origin. */
  toolResults: z.array(z.object({ origin: contentOriginSchema, calls: count, chars: count })),
  timeline: z.array(aiRunTimelineEntrySchema),
});
export type AiRunInspection = z.infer<typeof aiRunInspectionSchema>;
