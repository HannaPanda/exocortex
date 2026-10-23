import {
  AI_RUN_EVENT_LIMIT,
  type AiRun,
  type AiRunContextSection,
  type AiRunEventData,
  aiRunEventDataSchema,
  type AiRunInspection,
  type AiRunTimelineEntry,
  type AttentionKind,
  type AttentionStatus,
  type ChangesetStatus,
  type ContentOrigin,
} from '@exocortex/contracts';

/**
 * Turns what was recorded about a run into the inspection the reader sees
 * (issue #145, ADR-073). Pure: the service loads the rows and the titles the
 * reader may see, and everything about how they become one timeline is here.
 */

/** A stored step, as the service selects it. */
export interface RunEventRow {
  sequence: number;
  kind: string;
  at: Date;
  durationMs: number | null;
  data: unknown;
}

/** The run's own columns the inspection reads beyond the wire shape. */
export interface InspectedRunRow {
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  correlationId: string | null;
  traceId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  providerCostMicroUsd: number | null;
  estimatedCostMicroUsd: number | null;
  durationMs: number | null;
}

/** What other tables know about the run, joined in at read time. */
export interface RunRelations {
  attention: {
    id: string;
    kind: AttentionKind;
    status: AttentionStatus;
    title: string;
    blocking: boolean;
    createdAt: Date;
    settledAt: Date | null;
    resumedRunId: string | null;
  }[];
  changesets: { id: string; title: string; status: ChangesetStatus; createdAt: Date }[];
  checkpoints: { id: string; trigger: string; createdAt: Date }[];
  /** Earlier runs whose answered question this run carries on. */
  resumedFrom: { runId: string; at: Date }[];
}

/** Titles the reader may see, by document id and by saved query id. */
export interface VisibleTitles {
  documents: ReadonlyMap<string, string>;
  savedQueries: ReadonlyMap<string, string>;
}

type RecordedEvent = AiRunEventData & { at: Date; durationMs: number | null };

/** Steps that fit the contract, in the order they were recorded. An unknown kind is skipped, not fatal. */
export function parseEvents(rows: readonly RunEventRow[]): RecordedEvent[] {
  return [...rows]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((row) => {
      const parsed = aiRunEventDataSchema.safeParse({ kind: row.kind, data: row.data });
      return parsed.success ? [{ ...parsed.data, at: row.at, durationMs: row.durationMs }] : [];
    });
}

/** The page a tool call's target names, when it names one. */
export function targetDocumentId(target: string | null): string | null {
  if (target === null) return null;
  const match = /^(?:document|page):([^\s:]+)$/.exec(target);
  return match?.[1] ?? null;
}

/** Every id the inspection would like a title for; the service decides which the reader gets. */
export function referencedIds(events: readonly RecordedEvent[]): {
  documentIds: string[];
  savedQueryIds: string[];
} {
  const documentIds = new Set<string>();
  const savedQueryIds = new Set<string>();
  const sources = events.flatMap((event) =>
    event.kind === 'context' ? event.data.sections.flatMap((section) => section.sources) : [],
  );
  for (const source of sources) {
    if (source.documentId !== null) documentIds.add(source.documentId);
    if (source.savedQueryId !== null) savedQueryIds.add(source.savedQueryId);
  }
  for (const event of events) {
    const id = event.kind === 'tool_call' ? targetDocumentId(event.data.target) : null;
    if (id !== null) documentIds.add(id);
  }
  return { documentIds: [...documentIds], savedQueryIds: [...savedQueryIds] };
}

function iso(date: Date): string {
  return date.toISOString();
}

/** The title a source shows the reader, or null when it is gone or not theirs to see. */
function sourceTitle(
  source: { documentId: string | null; savedQueryId: string | null },
  titles: VisibleTitles,
): string | null {
  if (source.savedQueryId !== null) return titles.savedQueries.get(source.savedQueryId) ?? null;
  if (source.documentId !== null) return titles.documents.get(source.documentId) ?? null;
  return null;
}

function withTitles(sections: readonly AiRunContextSection[], titles: VisibleTitles) {
  return sections.map((section) => ({
    ...section,
    sources: section.sources.map((source) => ({ ...source, title: sourceTitle(source, titles) })),
  }));
}

function recordedEntry(event: RecordedEvent, titles: VisibleTitles): AiRunTimelineEntry {
  const base = { at: iso(event.at), durationMs: event.durationMs };
  switch (event.kind) {
    case 'context':
      return {
        ...base,
        kind: 'context',
        chars: event.data.sections.reduce((total, section) => total + section.chars, 0),
        estimatedTokens: event.data.sections.reduce(
          (total, section) => total + section.estimatedTokens,
          0,
        ),
      };
    case 'tool_call': {
      const documentId = targetDocumentId(event.data.target);
      return {
        ...base,
        kind: 'tool_call',
        ...event.data,
        targetTitle: documentId === null ? null : (titles.documents.get(documentId) ?? null),
      };
    }
    case 'compaction':
      return { ...base, kind: 'compaction', ...event.data };
    case 'turn':
      return { ...base, kind: 'turn', ...event.data };
    case 'truncation_retry':
      return { ...base, kind: 'truncation_retry', ...event.data };
    case 'tool_routing':
      return { ...base, kind: 'tool_routing', ...event.data };
  }
}

function relationEntries(run: AiRun, relations: RunRelations): AiRunTimelineEntry[] {
  const entries: AiRunTimelineEntry[] = [];
  for (const item of relations.attention) {
    entries.push({
      at: iso(item.createdAt),
      durationMs: null,
      kind: 'attention_raised',
      attentionItemId: item.id,
      attentionKind: item.kind,
      title: item.title,
      blocking: item.blocking,
    });
    if (item.settledAt !== null) {
      entries.push({
        at: iso(item.settledAt),
        durationMs: null,
        kind: 'attention_settled',
        attentionItemId: item.id,
        status: item.status,
      });
      if (item.resumedRunId !== null && item.resumedRunId !== run.id) {
        entries.push({
          at: iso(item.settledAt),
          durationMs: null,
          kind: 'resumed_as',
          runId: item.resumedRunId,
        });
      }
    }
  }
  for (const changeset of relations.changesets) {
    entries.push({
      at: iso(changeset.createdAt),
      durationMs: null,
      kind: 'changeset',
      changesetId: changeset.id,
      title: changeset.title,
      status: changeset.status,
    });
  }
  for (const checkpoint of relations.checkpoints) {
    entries.push({
      at: iso(checkpoint.createdAt),
      durationMs: null,
      kind: 'work_checkpoint',
      checkpointId: checkpoint.id,
      trigger: checkpoint.trigger,
    });
  }
  for (const earlier of relations.resumedFrom) {
    entries.push({
      at: iso(earlier.at),
      durationMs: null,
      kind: 'resumed_from',
      runId: earlier.runId,
    });
  }
  return entries;
}

/** Orders by time; at the same instant the run's own life frame stays outside the steps. */
const KIND_ORDER: Partial<Record<AiRunTimelineEntry['kind'], number>> = {
  resumed_from: -2,
  created: -1,
  finished: 1,
};

function summarize(events: readonly RecordedEvent[], row: InspectedRunRow) {
  const turns = events.flatMap((event) => (event.kind === 'turn' ? [event.data] : []));
  const calls = events.flatMap((event) => (event.kind === 'tool_call' ? [event.data] : []));
  const providers: string[] = [];
  let providerSwitches = 0;
  let previous: string | null = null;
  for (const turn of turns) {
    if (turn.servedBy === null) continue;
    if (!providers.includes(turn.servedBy)) providers.push(turn.servedBy);
    if (previous !== null && previous !== turn.servedBy) providerSwitches += 1;
    previous = turn.servedBy;
  }
  return {
    durationMs:
      row.durationMs ??
      (row.startedAt !== null && row.finishedAt !== null
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : null),
    turns: turns.length,
    toolCalls: calls.length,
    failedToolCalls: calls.filter(
      (call) => call.status !== 'succeeded' && call.status !== 'skipped',
    ).length,
    providers,
    providerSwitches,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    providerCostMicroUsd: row.providerCostMicroUsd,
    estimatedCostMicroUsd: row.estimatedCostMicroUsd,
  };
}

function toolResultsByOrigin(events: readonly RecordedEvent[]): AiRunInspection['toolResults'] {
  const byOrigin = new Map<ContentOrigin, { calls: number; chars: number }>();
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.data.status === 'undelivered') continue;
    const origin = event.data.untrustedOrigin ?? 'internal';
    const entry = byOrigin.get(origin) ?? { calls: 0, chars: 0 };
    entry.calls += 1;
    entry.chars += event.data.resultChars;
    byOrigin.set(origin, entry);
  }
  return [...byOrigin].map(([origin, entry]) => ({ origin, ...entry }));
}

export function buildRunInspection(input: {
  run: AiRun;
  row: InspectedRunRow;
  events: readonly RunEventRow[];
  relations: RunRelations;
  titles: VisibleTitles;
}): AiRunInspection {
  const { run, row, relations, titles } = input;
  const events = parseEvents(input.events);
  const contextEvent = events.find((event) => event.kind === 'context');

  const timeline: AiRunTimelineEntry[] = [
    { at: iso(row.createdAt), durationMs: null, kind: 'created' },
    ...(row.startedAt === null
      ? []
      : [{ at: iso(row.startedAt), durationMs: null, kind: 'started' as const }]),
    ...events.map((event) => recordedEntry(event, titles)),
    ...relationEntries(run, relations),
    ...(row.finishedAt === null
      ? []
      : [
          {
            at: iso(row.finishedAt),
            durationMs: summarize(events, row).durationMs,
            kind: 'finished' as const,
            status: run.status,
            errorCode: run.errorCode,
          },
        ]),
  ];
  // Stable: steps recorded in the same millisecond keep their recorded order.
  const ordered = timeline
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Date.parse(a.entry.at) - Date.parse(b.entry.at) ||
        (KIND_ORDER[a.entry.kind] ?? 0) - (KIND_ORDER[b.entry.kind] ?? 0) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);

  return {
    run,
    trace: { correlationId: row.correlationId, traceId: row.traceId },
    recorded: events.length > 0,
    eventsCapped: input.events.length >= AI_RUN_EVENT_LIMIT,
    summary: summarize(events, row),
    context:
      contextEvent?.kind === 'context'
        ? {
            chars: contextEvent.data.sections.reduce((total, section) => total + section.chars, 0),
            estimatedTokens: contextEvent.data.sections.reduce(
              (total, section) => total + section.estimatedTokens,
              0,
            ),
            sections: withTitles(contextEvent.data.sections, titles),
          }
        : null,
    toolResults: toolResultsByOrigin(events),
    timeline: ordered,
  };
}
