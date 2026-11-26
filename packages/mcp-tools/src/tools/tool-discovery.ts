import { z } from 'zod';

import { domainLabel } from '../domains.js';
import { type AnyToolDefinition, defineTool, type ToolResult } from '../tool.js';

/**
 * Finding and calling a tool this connection was not listed (issue #256).
 *
 * A spike, deliberately small. ChatGPT refuses a connector whose `tools/list`
 * is the whole catalogue, so `/api/mcp/compact` lists the everyday domains and
 * nothing else; the rest of the catalogue simply did not exist for it. These
 * two tools are the question whether a client can be told about the rest on
 * demand: `exo_tool_search` looks through the tools the connection was *not*
 * listed and answers with their names, descriptions, operation class and, for
 * the ones it may call, the input schema; `exo_tool_execute` runs one of those.
 *
 * What `exo_tool_execute` reaches is an explicit list (`executable`), not
 * everything search can find, and it never reaches a tool that destroys or
 * cannot be undone, whatever the list says. It is not a second way to run a
 * tool: `dispatch` is the connection's own `callTool`, so the target's schema,
 * the confirmation gate, the agent session journal and the loopback
 * credential with its scopes apply exactly as on a direct call. That is also
 * why it declares no `target`: the gate keys on the tool that actually writes,
 * inside `dispatch`, and a second gate around the envelope would ask twice.
 *
 * Built per connection by `createMcpRequestHandler`, never put in the
 * catalogue: what is hidden depends on what the connection was listed, and
 * the dispatcher is the connection's.
 */

export const TOOL_SEARCH_NAME = 'exo_tool_search';
export const TOOL_EXECUTE_NAME = 'exo_tool_execute';

/** Results one search returns when the caller names no limit, and the most it may ask for. */
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

/**
 * Why `exo_tool_execute` refused, as a code a client can branch on. The text
 * beside it says the same for the model.
 */
export type ToolDispatchRefusal =
  | 'tool_unknown'
  | 'tool_directly_exposed'
  | 'tool_recursive'
  | 'tool_irreversible'
  | 'tool_not_allowed';

/** Function words that would match half the catalogue and mean nothing in a query. */
const STOPWORDS = new Set([
  'and',
  'auf',
  'aus',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einen',
  'einer',
  'for',
  'für',
  'ich',
  'ist',
  'mit',
  'nach',
  'oder',
  'the',
  'und',
  'von',
  'was',
  'wie',
  'zum',
  'zur',
]);

/**
 * The words of a query, cut to a crude stem.
 *
 * German inflects at the end, so "Entitäten" has to find "Entität" and
 * "Seitenbreite" has to find "Breite" only by luck. Dropping the last two
 * letters of a longer word is enough for a spike; issue #256 rules out
 * embeddings on purpose, because whether a client uses the tools at all is the
 * question, not how well a ranking ranks.
 */
function queryStems(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words.map((word) => (word.length > 5 ? word.slice(0, -2) : word)))];
}

function scoreTool(tool: AnyToolDefinition, stems: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const nameWords = name.replaceAll('_', ' ');
  const description = tool.description.toLowerCase();
  const domain = `${tool.domain} ${domainLabel(tool.domain)}`.toLowerCase();
  let score = 0;
  for (const stem of stems) {
    if (name.includes(stem) || nameWords.includes(stem)) score += 3;
    if (description.includes(stem)) score += 1;
    if (domain.includes(stem)) score += 1;
  }
  return score;
}

function operationOf(tool: AnyToolDefinition): 'read' | 'write' {
  return tool.mutating ? 'write' : 'read';
}

function refuse(code: ToolDispatchRefusal, tool: string, text: string): ToolResult {
  return { text, isError: true, data: { error: code, tool } };
}

export function createToolDiscoveryTools(input: {
  /** Every tool of the surface. What the connection was listed is taken out below. */
  catalogue: readonly AnyToolDefinition[];
  /** Names this connection lists directly. */
  listed: readonly string[];
  /** Names `exo_tool_execute` may dispatch to. Destroying or irreversible ones are dropped. */
  executable: readonly string[];
  /** The connection's own `callTool`. */
  dispatch: (tool: AnyToolDefinition, rawInput: unknown) => Promise<ToolResult>;
}): AnyToolDefinition[] {
  const listed = new Set(input.listed);
  const meta = new Set([TOOL_SEARCH_NAME, TOOL_EXECUTE_NAME]);
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

  const search = defineTool({
    name: 'exo_tool_search',
    description:
      'Sucht Werkzeuge, die diese Verbindung nicht direkt anbietet. Diese Verbindung listet nur ' +
      'die alltäglichen Werkzeuge (Seiten, Suche, Datenbanken, Kommentare, Verlauf, Eingang, ' +
      'Vorlagen); eXocortex kann mehr, etwa Entitäten, Seitenlayout, Freigaben, Aufträge oder ' +
      'Projekte. Fehlt dir ein Werkzeug für eine Aufgabe, such hier mit ein paar Stichworten ' +
      'danach. Die Antwort nennt Name, Beschreibung, ob es liest oder schreibt, und bei den ' +
      'Werkzeugen, die du über exo_tool_execute aufrufen kannst (executable: true), das ' +
      'Eingabeschema.',
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          'Stichworte zur Aufgabe, zum Beispiel "Entitäten auflisten" oder "Seitenbreite".',
        ),
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
      const stems = queryStems(query.query);
      const ranked = [...hidden.values()]
        .map((tool) => ({ tool, score: scoreTool(tool, stems) }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(executable.has(b.tool.name)) - Number(executable.has(a.tool.name)) ||
            a.tool.name.localeCompare(b.tool.name),
        )
        .slice(0, query.limit ?? DEFAULT_SEARCH_LIMIT);

      const results = ranked.map(({ tool }) => {
        const callable = executable.has(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          operation: operationOf(tool),
          destructive: tool.destructive,
          domain: tool.domain,
          executable: callable,
          ...(callable
            ? { inputSchema: tool.jsonSchema }
            : { reason: tool.destructive || tool.irreversible ? 'irreversible' : 'not_allowed' }),
        };
      });

      if (results.length === 0) {
        return Promise.resolve({
          text: `Kein weiteres Werkzeug passt zu „${query.query}“. Versuch andere Stichworte.`,
          data: { query: query.query, results },
        });
      }

      const lines = ranked.map(({ tool }) =>
        executable.has(tool.name)
          ? `- ${tool.name} (${operationOf(tool)}, über exo_tool_execute aufrufbar): ` +
            `${tool.description}\n  Eingabeschema: ${JSON.stringify(tool.jsonSchema)}`
          : `- ${tool.name} (${operationOf(tool)}, über diese Verbindung nicht aufrufbar): ` +
            tool.description,
      );
      return Promise.resolve({
        text:
          `Werkzeuge zu „${query.query}“, die diese Verbindung nicht direkt anbietet:\n\n` +
          `${lines.join('\n')}\n\n` +
          'Aufrufbare Werkzeuge führst du mit exo_tool_execute aus: tool ist der Name, ' +
          'arguments das Objekt nach dem Eingabeschema.',
        data: { query: query.query, results },
      });
    },
  });

  const execute = defineTool({
    name: 'exo_tool_execute',
    description:
      'Führt ein Werkzeug aus, das du mit exo_tool_search gefunden hast und das dort als ' +
      'executable: true markiert ist. tool ist sein Name, arguments das Eingabeobjekt nach dem ' +
      'Schema aus der Suche. Es gelten dieselben Rechte und Prüfungen wie bei einem direkten ' +
      'Aufruf. Werkzeuge, die diese Verbindung direkt anbietet, rufst du direkt auf, nicht hierüber.',
    inputSchema: z.object({
      tool: z.string().trim().min(1).max(100).describe('Name des Werkzeugs aus exo_tool_search.'),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Eingabe für das Werkzeug, nach dem Eingabeschema aus exo_tool_search.'),
    }),
    surfaces: ['mcp'],
    domain: 'core',
    // Honest towards the client: it can write, so a client that asks its
    // person before a write asks here too. Which tool it reaches decides
    // whether this call does; the annotation is per tool, not per call.
    mutating: true,
    execute(_client, call) {
      const name = call.tool;
      if (meta.has(name)) {
        return Promise.resolve(
          refuse(
            'tool_recursive',
            name,
            `${name} lässt sich nicht über exo_tool_execute aufrufen.`,
          ),
        );
      }
      if (listed.has(name)) {
        return Promise.resolve(
          refuse(
            'tool_directly_exposed',
            name,
            `${name} bietet diese Verbindung direkt an. Ruf es direkt auf, nicht über exo_tool_execute.`,
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
            `${name} ist über diese Verbindung nicht freigegeben. Aufrufbar sind: ` +
              `${[...executable].join(', ')}.`,
          ),
        );
      }
      return input.dispatch(tool, call.arguments ?? {});
    },
  });

  return [search, execute];
}
