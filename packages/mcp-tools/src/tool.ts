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
