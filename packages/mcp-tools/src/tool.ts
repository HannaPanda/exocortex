import { z } from 'zod';

import { type ExocortexApiClient } from './client.js';

/**
 * Where a tool is offered.
 *
 * `mcp` is the full catalogue an agent gets, over stdio or over the HTTP
 * endpoint. `ai` is the built-in tool loop in the worker. `research` is the
 * two-tool surface ChatGPT's deep research connector insists on: it requires
 * tools named exactly `search` and `fetch` and works badly when it is handed
 * dozens of others, so it gets a deliberately tiny catalogue of its own.
 */
export type ToolSurface = 'mcp' | 'ai' | 'research';

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
   * Identifies the write target for the destination-keyed confirmation gate.
   * Required for every mutating tool, absent for read-only tools.
   */
  target?: (input: TInput) => string;
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
  jsonSchema: unknown;
  /** True when the underlying `ToolDefinition` declared a `target` function. */
  hasTarget: boolean;
  targetOf: (input: unknown) => string | null;
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

/**
 * Erases the input type while keeping validation. `run` parses `rawInput` with
 * the tool's own schema before calling `execute`, so an unvalidated value can
 * never reach a tool body — this is the one place a cast happens, and it is
 * guarded by the parse immediately above it.
 */
export function defineTool<TInput>(definition: ToolDefinition<TInput>): AnyToolDefinition {
  const jsonSchema = z.toJSONSchema(definition.inputSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });

  return {
    name: definition.name,
    description: definition.description,
    surfaces: definition.surfaces,
    mutating: definition.mutating,
    // A tool that changes nothing cannot destroy anything, whatever it claims.
    destructive: definition.mutating && (definition.destructive ?? false),
    jsonSchema,
    hasTarget: definition.target !== undefined,
    targetOf(rawInput: unknown): string | null {
      if (definition.target === undefined) return null;
      const parsed = definition.inputSchema.safeParse(rawInput);
      if (!parsed.success) return null;
      return definition.target(parsed.data);
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
