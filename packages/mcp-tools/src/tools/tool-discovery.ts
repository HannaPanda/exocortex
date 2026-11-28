import { z } from 'zod';

import { type CompactWithholding, compactWithholding } from '../compact-executable.js';
import { type AnyToolDefinition, defineTool, type ToolResult } from '../tool.js';
import { rankTools } from '../tool-search.js';

/**
 * Finding and calling a tool this connection was not listed (issues #256,
 * #265).
 *
 * ChatGPT refuses a connector whose `tools/list` is the whole catalogue, so
 * `/api/mcp/compact` lists the everyday domains and nothing else. These tools
 * are how the rest of the catalogue still reaches it: `exo_tool_search` looks
 * through the tools the connection was *not* listed and answers with their
 * names, descriptions, operation class and, for the ones it may call, the
 * input schema; `exo_tool_read` runs one that only reads, `exo_tool_write`
 * one that writes.
 *
 * Two dispatchers rather than one, because a client decides per tool whether
 * to ask its person first, from `readOnlyHint`. A single dispatcher had to
 * say `readOnlyHint: false` honestly, and every read through it then looked
 * like a write. `exo_tool_read` says `true` and keeps the promise: it refuses
 * every tool the catalogue marks as `mutating`, whatever the call claims.
 *
 * What the dispatchers reach is `executable` (see `compact-executable.ts`),
 * not everything search finds, and never a tool that destroys or cannot be
 * undone, whatever the list says. They are not a second way to run a tool:
 * `dispatch` is the connection's own `callTool`, so the target's schema, the
 * confirmation gate, the agent session journal and the loopback credential
 * with its scopes apply exactly as on a direct call. That is also why they
 * declare no `target`: the gate keys on the tool that actually writes, inside
 * `dispatch`, and a second gate around the envelope would ask twice.
 *
 * `exo_tool_execute`, the spike's single dispatcher, stays callable for the
 * connectors that cached it, as `exo_tool_write` under its old name with the
 * same checks. It is no longer listed, so a reconnected client sees the pair.
 *
 * Built per connection by `createMcpRequestHandler`, never put in the
 * catalogue: what is hidden depends on what the connection was listed, and
 * the dispatcher is the connection's.
 */

export const TOOL_SEARCH_NAME = 'exo_tool_search';
export const TOOL_READ_NAME = 'exo_tool_read';
export const TOOL_WRITE_NAME = 'exo_tool_write';
export const TOOL_EXECUTE_NAME = 'exo_tool_execute';

/** The envelopes whose `arguments.tool` names the tool that really runs. */
export const TOOL_DISPATCHER_NAMES: readonly string[] = [
  TOOL_READ_NAME,
  TOOL_WRITE_NAME,
  TOOL_EXECUTE_NAME,
];

/** Results one search returns when the caller names no limit, and the most it may ask for. */
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

/**
 * Why a dispatcher refused, as a code a client can branch on. The text beside
 * it says the same for the model.
 */
export type ToolDispatchRefusal =
  | 'tool_unknown'
  | 'tool_directly_exposed'
  | 'tool_recursive'
  | 'tool_irreversible'
  | 'tool_not_allowed'
  | 'tool_not_read_only';

/** What a search result says about a tool it cannot run, by withholding. */
function reasonOf(withholding: CompactWithholding | null): string {
  return withholding === 'irreversible' ? 'irreversible' : 'not_allowed';
}

function refuse(code: ToolDispatchRefusal, tool: string, text: string): ToolResult {
  return { text, isError: true, data: { error: code, tool } };
}

const dispatchInput = z.object({
  tool: z.string().trim().min(1).max(100).describe('Name aus exo_tool_search.'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Eingabe nach dem Schema aus exo_tool_search.'),
});

export interface ToolDiscoveryTools {
  /** What the connection lists beside its own tools. */
  listed: AnyToolDefinition[];
  /** Callable by name, never listed: `exo_tool_execute` for cached connectors. */
  aliases: AnyToolDefinition[];
}

export function createToolDiscoveryTools(input: {
  /** Every tool of the surface. What the connection was listed is taken out below. */
  catalogue: readonly AnyToolDefinition[];
  /** Names this connection lists directly. */
  listed: readonly string[];
  /** Names the dispatchers may run. Destroying or irreversible ones are dropped. */
  executable: readonly string[];
  /** Extra words per tool name for the search (the feature entry's title and summary). */
  searchText?: ReadonlyMap<string, string>;
  /** The connection's own `callTool`. */
  dispatch: (tool: AnyToolDefinition, rawInput: unknown) => Promise<ToolResult>;
}): ToolDiscoveryTools {
  const listed = new Set(input.listed);
  const meta = new Set([TOOL_SEARCH_NAME, ...TOOL_DISPATCHER_NAMES]);
  const hidden = new Map(
    input.catalogue
      .filter((tool) => !listed.has(tool.name) && !meta.has(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  const executable = new Set(
    input.executable.filter((name) => {
      const tool = hidden.get(name);
      return tool !== undefined && !tool.destructive && !tool.irreversible;
    }),
  );

  const dispatcherFor = (tool: AnyToolDefinition) =>
    tool.mutating ? TOOL_WRITE_NAME : TOOL_READ_NAME;

  /**
   * Every check a dispatcher makes before it hands the call on, in the order
   * a client most needs to hear about. `readOnly` is `exo_tool_read`'s one
   * extra promise.
   */
  function run(envelope: string, call: z.infer<typeof dispatchInput>, readOnly: boolean) {
    const name = call.tool;
    if (meta.has(name)) {
      return Promise.resolve(
        refuse('tool_recursive', name, `${name} lässt sich nicht über ${envelope} aufrufen.`),
      );
    }
    if (listed.has(name)) {
      return Promise.resolve(
        refuse(
          'tool_directly_exposed',
          name,
          `${name} bietet diese Verbindung direkt an. Ruf es direkt auf, nicht über ${envelope}.`,
        ),
      );
    }
    const tool = hidden.get(name);
    if (tool === undefined) {
      return Promise.resolve(
        refuse(
          'tool_unknown',
          name,
          `Ein Werkzeug „${name}“ gibt es nicht. Such mit exo_tool_search nach dem richtigen Namen.`,
        ),
      );
    }
    if (tool.destructive || tool.irreversible) {
      return Promise.resolve(
        refuse(
          'tool_irreversible',
          name,
          `${name} kann Inhalte entfernen oder lässt sich nicht rückgängig machen und ist über ` +
            'diese Verbindung nicht erreichbar.',
        ),
      );
    }
    if (!executable.has(name)) {
      return Promise.resolve(
        refuse(
          'tool_not_allowed',
          name,
          `${name} ist über diese Verbindung nicht freigegeben. Das geht nur im Browser oder ` +
            'über eine Verbindung mit dem vollen Werkzeugkatalog.',
        ),
      );
    }
    if (readOnly && tool.mutating) {
      return Promise.resolve(
        refuse(
          'tool_not_read_only',
          name,
          `${name} schreibt und lässt sich deshalb nicht über ${TOOL_READ_NAME} aufrufen. ` +
            `Nimm ${TOOL_WRITE_NAME}.`,
        ),
      );
    }
    return input.dispatch(tool, call.arguments ?? {});
  }

  const search = defineTool({
    name: 'exo_tool_search',
    description:
      'Sucht Werkzeuge, die diese Verbindung nicht direkt anbietet, etwa für Entitäten, ' +
      'Seitenlayout, Aufträge, Projekte oder Workflows. Fehlt dir eins, such mit Stichworten. ' +
      'Jeder Treffer sagt, ob er liest oder schreibt; aufrufbare bringen ihr Eingabeschema und ' +
      'ihren Aufrufweg mit: exo_tool_read für lesende, exo_tool_write für schreibende.',
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Stichworte zur Aufgabe, etwa "Entitäten auflisten" oder "Seitenbreite".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(`Höchstzahl der Treffer, Standard ${String(DEFAULT_SEARCH_LIMIT)}.`),
    }),
    surfaces: ['mcp'],
    domain: 'core',
    mutating: false,
    execute(_client, query) {
      const ranked = rankTools({
        tools: [...hidden.values()],
        query: query.query,
        ...(input.searchText === undefined ? {} : { searchText: input.searchText }),
        prefer: executable,
      }).slice(0, query.limit ?? DEFAULT_SEARCH_LIMIT);

      const results = ranked.map(({ tool }) => {
        const callable = executable.has(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          operation: tool.mutating ? 'write' : 'read',
          destructive: tool.destructive,
          domain: tool.domain,
          executable: callable,
          ...(callable
            ? { dispatcher: dispatcherFor(tool), inputSchema: tool.jsonSchema }
            : { reason: reasonOf(compactWithholding(tool)) }),
        };
      });

      if (results.length === 0) {
        return Promise.resolve({
          text: `Kein weiteres Werkzeug passt zu „${query.query}“. Versuch andere Stichworte.`,
          data: { query: query.query, results },
        });
      }

      const lines = ranked.map(({ tool }) => {
        const operation = tool.mutating ? 'schreibt' : 'liest';
        return executable.has(tool.name)
          ? `- ${tool.name} (${operation}, über ${dispatcherFor(tool)} aufrufbar): ` +
              `${tool.description}\n  Eingabeschema: ${JSON.stringify(tool.jsonSchema)}`
          : `- ${tool.name} (${operation}, über diese Verbindung nicht aufrufbar): ` +
              tool.description;
      });
      return Promise.resolve({
        text:
          `Werkzeuge zu „${query.query}“, die diese Verbindung nicht direkt anbietet:\n\n` +
          `${lines.join('\n')}\n\n` +
          `Aufrufbare Werkzeuge führst du mit dem genannten Aufrufweg aus (${TOOL_READ_NAME} ` +
          `oder ${TOOL_WRITE_NAME}): tool ist der Name, arguments das Objekt nach dem ` +
          'Eingabeschema.',
        data: { query: query.query, results },
      });
    },
  });

  const read = defineTool({
    name: 'exo_tool_read',
    description:
      'Führt ein lesendes Werkzeug aus, das exo_tool_search als aufrufbar meldet ' +
      '(Aufrufweg exo_tool_read). Ändert nie etwas: schreibende Werkzeuge lehnt es ab. ' +
      'Dieselben Rechte wie bei einem direkten Aufruf.',
    inputSchema: dispatchInput,
    surfaces: ['mcp'],
    domain: 'core',
    // The promise `readOnlyHint: true` makes, kept by the refusal in `run`.
    mutating: false,
    execute(_client, call) {
      return run(TOOL_READ_NAME, call, true);
    },
  });

  const write = defineTool({
    name: 'exo_tool_write',
    description:
      'Führt ein schreibendes Werkzeug aus, das exo_tool_search als aufrufbar meldet ' +
      '(Aufrufweg exo_tool_write). Erreicht nie etwas, das löscht oder sich nicht zurücknehmen ' +
      'lässt. Dieselben Rechte und Prüfungen wie bei einem direkten Aufruf.',
    inputSchema: dispatchInput,
    surfaces: ['mcp'],
    domain: 'core',
    // Honest towards the client: it writes, so a client that asks its person
    // before a write asks here. It reaches nothing destructive, which is what
    // `destructiveHint: false` says. A read sent here still runs, so a client
    // that only knows this one loses nothing.
    mutating: true,
    execute(_client, call) {
      return run(TOOL_WRITE_NAME, call, false);
    },
  });

  // The spike's name, kept callable for connectors that cached their tool
  // list before issue #265. Same function, same checks as `exo_tool_write`.
  const execute = defineTool({
    name: 'exo_tool_execute',
    description: 'Früherer Name von exo_tool_write, für bestehende Verbindungen.',
    inputSchema: dispatchInput,
    surfaces: ['mcp'],
    domain: 'core',
    mutating: true,
    execute(_client, call) {
      return run(TOOL_EXECUTE_NAME, call, false);
    },
  });

  return { listed: [search, read, write], aliases: [execute] };
}
