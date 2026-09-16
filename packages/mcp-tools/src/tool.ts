import { z } from 'zod';

import { type UntrustedOrigin } from '@exocortex/contracts';

import { type ExocortexApiClient } from './client.js';

/**
 * Where a tool is offered.
 *
 * `mcp` is the full catalogue an agent gets, over stdio or over the HTTP
 * endpoint. `ai` is the built-in tool loop in the worker. `research` is the
 * two-tool surface ChatGPT's deep research connector insists on: it requires
 * tools named exactly `search` and `fetch` and works badly when it is handed
 * dozens of others, so it gets a deliberately tiny catalogue of its own.
 * `memory` is the same argument applied to an ordinary chat connector: three
 * tools (`recall`, `remember`, `fetch`) that make eXocortex a memory rather
 * than a reference work (issue #34).
 */
export type ToolSurface = 'mcp' | 'ai' | 'research' | 'memory';

export interface ToolDefinition<TInput> {
  /**
   * Stable, namespaced name. `exo_` prefix so it cannot collide with the other
   * MCP servers Hermes spawns (flauschibrain, flauschi-mcp, health-app).
   */
  name: string;
  /** German one-liner shown to the model and in `tools/list`. */
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** Surfaces this tool is offered on. */
  surfaces: readonly ToolSurface[];
  /**
   * True when the tool changes data. Drives the confirmation gate and the
   * `ai.mutatingToolsEnabled` setting.
   */
  mutating: boolean;
  /**
   * True when the write can take something away that was there before: a
   * deletion, or an overwrite of content a person authored. Creating,
   * uploading, moving and restoring stay `false`, and so do the reversible
   * metadata switches (layout, cover, AI rule, resolving a comment): flipping
   * one back costs a click, so treating them as dangerous only teaches people
   * to click past the warning that matters.
   *
   * It is reported to MCP clients as `destructiveHint`, which is how a client
   * decides whether to ask a human before running the tool. The distinction is
   * per tool, not per call, so a tool that can overwrite depending on its
   * arguments (`exo_page_write` with `mode: 'replace'`) counts as destructive
   * even when this particular call only appends.
   */
  destructive?: boolean;
  /**
   * True when nothing brings the data back: no snapshot, no trash, no restore.
   *
   * This is the narrow subset of `destructive` that the two-step confirmation
   * gate still applies to. The distinction matters because the gate is a weak
   * control: anyone holding the bearer token simply sends the call twice, and
   * the prompt is read by the model, never by a person -- both MCP clients this
   * deployment serves already ask their human before a write. What it costs is
   * real, though: a model that rewords its Markdown between the two attempts
   * hashes differently, never confirms, and loops. So the gate is spent where
   * the snapshot cannot save the day afterwards, and nowhere else.
   */
  irreversible?: boolean;
  /**
   * Where the text this tool returns comes from, when that is not this
   * deployment (issue #56, ADR-030).
   *
   * Absent means `internal`: pages, comments, rows, anything a member of this
   * workspace wrote. Set it on a tool whose result carries text somebody
   * outside could have authored -- an extracted PDF, a fetched web page, a
   * mail body -- and the built-in AI's loop fences the result as data and
   * stops writing for the rest of the run (`decideMutation`).
   *
   * Per tool, not per call, for the same reason `destructive` is: a tool that
   * can return foreign text counts as one even on the call that happens to
   * return nothing.
   */
  untrustedOutput?: UntrustedOrigin;
  /**
   * Identifies the write target for the destination-keyed confirmation gate.
   * Required for every mutating tool, absent for read-only tools.
   */
  target?: (input: TInput) => string;
  /**
   * What this call would do, read before it is confirmed.
   *
   * The confirmation gate can only say "this changes data" -- it knows the tool
   * name and the payload, not the consequences. For an operation that cannot be
   * undone, that is not enough: "delete page X" hides that X has eleven pages
   * under it. A tool that can say so implements this, and the sentence it
   * returns is put in front of the confirmation prompt. Read-only, and its
   * failure is not the caller's problem: a preview that cannot be fetched is
   * left out rather than turned into an error, because the confirmation itself
   * still has to be offered.
   */
  preview?: (client: ExocortexApiClient, input: TInput) => Promise<string>;
  execute: (client: ExocortexApiClient, input: TInput) => Promise<ToolResult>;
}

/** What a tool returns. `text` is what the model or the MCP client sees. */
export interface ToolResult {
  text: string;
  /** Structured payload, mirrored into MCP `structuredContent`. */
  data?: unknown;
  isError?: boolean;
}

/** Existential wrapper so a heterogeneous catalogue stays typed without `any`. */
export interface AnyToolDefinition {
  name: string;
  description: string;
  surfaces: readonly ToolSurface[];
  mutating: boolean;
  /** See `ToolDefinition.destructive`. Always `false` for a read-only tool. */
  destructive: boolean;
  /** See `ToolDefinition.irreversible`. Always `false` for a read-only tool. */
  irreversible: boolean;
  /** See `ToolDefinition.untrustedOutput`. `null` when the tool returns this deployment's own text. */
  untrustedOutput: UntrustedOrigin | null;
  jsonSchema: unknown;
  /** True when the underlying `ToolDefinition` declared a `target` function. */
  hasTarget: boolean;
  targetOf: (input: unknown) => string | null;
  /** See `ToolDefinition.preview`. `null` when the tool has none, or it failed. */
  previewOf: (client: ExocortexApiClient, rawInput: unknown) => Promise<string | null>;
  run: (client: ExocortexApiClient, rawInput: unknown) => Promise<ToolResult>;
}

/**
 * A zod validation failure, surfaced the same way an `ExocortexApiError` is:
 * as a tool result with `isError: true`, never as a thrown JSON-RPC error, so
 * the calling model can read the issue and retry.
 */
export class ToolInputValidationError extends Error {
  constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
    super('Tool input validation failed');
    this.name = 'ToolInputValidationError';
  }
}

/** `(?=`, `(?!`, `(?<=`, `(?<!` — the constructs OpenAI's schema validator rejects. */
const LOOKAROUND = /\(\?[=!]|\(\?<[=!]/;

/**
 * Strips every `pattern` that uses a regex lookaround.
 *
 * OpenAI (and Azure behind it) validate the whole `tools` array against a
 * dialect that has no lookaround, and reject the *entire request* when one
 * pattern uses it — not the offending tool, the request. `z.email()` in zod 4
 * emits `^(?!\.)(?!.*\.\.)…`, so adding a single tool that takes an email
 * address silently disabled the built-in AI's tool loop altogether: every run
 * came back `ai_provider_unavailable`, with nothing naming the tool that did it.
 *
 * Dropping the pattern costs nothing that matters. This schema is what the model
 * is *told* about the arguments; what actually guards the call is
 * `definition.inputSchema.safeParse` in `run` below, and then the API's own
 * validation behind that. A model that invents a malformed address now gets a
 * readable validation error back instead of every tool disappearing.
 */
function withoutLookaroundPatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutLookaroundPatterns);
  if (schema === null || typeof schema !== 'object') return schema;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && typeof value === 'string' && LOOKAROUND.test(value)) continue;
    result[key] = withoutLookaroundPatterns(value);
  }
  return result;
}

/**
 * Erases the input type while keeping validation. `run` parses `rawInput` with
 * the tool's own schema before calling `execute`, so an unvalidated value can
 * never reach a tool body — this is the one place a cast happens, and it is
 * guarded by the parse immediately above it.
 */
export function defineTool<TInput>(definition: ToolDefinition<TInput>): AnyToolDefinition {
  const jsonSchema = withoutLookaroundPatterns(
    z.toJSONSchema(definition.inputSchema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }),
  );

  return {
    name: definition.name,
    description: definition.description,
    surfaces: definition.surfaces,
    mutating: definition.mutating,
    // A tool that changes nothing cannot destroy anything, whatever it claims.
    destructive: definition.mutating && (definition.destructive ?? false),
    irreversible: definition.mutating && (definition.irreversible ?? false),
    untrustedOutput: definition.untrustedOutput ?? null,
    jsonSchema,
    hasTarget: definition.target !== undefined,
    targetOf(rawInput: unknown): string | null {
      if (definition.target === undefined) return null;
      const parsed = definition.inputSchema.safeParse(rawInput);
      if (!parsed.success) return null;
      return definition.target(parsed.data);
    },
    async previewOf(client: ExocortexApiClient, rawInput: unknown): Promise<string | null> {
      if (definition.preview === undefined) return null;
      const parsed = definition.inputSchema.safeParse(rawInput);
      if (!parsed.success) return null;
      try {
        return await definition.preview(client, parsed.data);
      } catch {
        return null;
      }
    },
    async run(client: ExocortexApiClient, rawInput: unknown): Promise<ToolResult> {
      const parsed = definition.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ToolInputValidationError(parsed.error.issues);
      }
      return definition.execute(client, parsed.data);
    },
  };
}
