import { toolsFor } from './catalog.js';
import { COMPACT_ENDPOINT_ALSO_LISTED_NAMES, COMPACT_ENDPOINT_DOMAINS } from './domains.js';
import { type AnyToolDefinition, type ToolDomain } from './tool.js';

/**
 * Which tools `/api/mcp/compact` may run without listing them (issue #265).
 *
 * The spike of issue #256 named two tools by hand. That does not scale to the
 * rest of the catalogue, and it hides the actual decision: over an OAuth
 * connection the loopback credential carries the person's whole authority, so
 * what the dispatchers can reach *is* what the connector may do. The list is
 * therefore derived from the catalogue's own facts by fixed criteria, and a
 * tool is released when it passes all of them and is not named in
 * `COMPACT_WITHHELD` below.
 *
 * The criteria, each answered by a field every tool already declares:
 *
 * 1. **The built-in AI may use it** (`surfaces` holds `ai`). A tool the
 *    built-in AI is not offered is one the deployment keeps for a person or
 *    an admin token, each with a written reason in `SURFACE_EXEMPT` of
 *    `scripts/check-capability-parity.mjs`: deciding a proposal (ADR-070),
 *    starting or cancelling a workflow run, writing an agent profile or an
 *    eval, cancelling an AI run. A chat model acting for a person through a
 *    connector is an agent like the built-in AI, and gets no more than it.
 * 2. **Nothing is lost** (`destructive` and `irreversible` are false). No
 *    deletion, no overwrite, no trash, nothing a snapshot cannot bring back.
 * 3. **Not about people, access or the deployment** (`domain` is not
 *    `admin` or `shares`): no accounts, no invitations, no grants or public
 *    links, no deployment settings. API tokens have no tool at all.
 * 4. **No standing instruction** (no write in `automations`). Writing an
 *    automation rule is admin class in `requestClassFor` (ADR-024): it keeps
 *    acting long after the connection that wrote it is gone. Reading the rules
 *    and their runs is an ordinary read and stays released.
 * 5. **Nothing from the open web** (`untrustedOutput` is not `web`). A chat
 *    client has its own web access; through this deployment it would spend
 *    the host's search and browser, and the dispatchers would have to carry
 *    `openWorldHint`, which they can only say of every call, never of one.
 *
 * Whether a call is a read is `mutating`, the same fact the annotations give
 * every directly listed tool as `readOnlyHint`. There is no second list of
 * operation classes; `exo_tool_read` refuses whatever the catalogue says
 * writes.
 *
 * None of this widens what a token may do: every call runs through the
 * connection's own `callTool` with its own credential, so scopes, a page
 * confinement (ADR-044) and the `propose` scope (ADR-070) are checked by the
 * API on every call exactly as on a direct one.
 */

/** Domains no dispatcher reaches, read or write (criterion 3). */
const WITHHELD_DOMAINS: readonly ToolDomain[] = ['admin', 'shares'];

/** Domains whose writes are a standing instruction (criterion 4). */
const STANDING_INSTRUCTION_DOMAINS: readonly ToolDomain[] = ['automations'];

/**
 * Tools that pass every criterion and are still withheld, each with its reason.
 * A new exception belongs here with a sentence, never as a quiet edit of a
 * criterion.
 */
export const COMPACT_WITHHELD: Readonly<Record<string, string>> = {
  exo_attention_resolve:
    'Answers a question or approval addressed to a person (ADR-067, ADR-068); a workflow ' +
    'approval refuses every agent outright (`attention_human_only`, ADR-078). A connector is ' +
    'an agent, and the answer is the person’s to give in the browser.',
  exo_memory_fact_promote:
    'Moves a fact from the agent memory into a curated workspace; promotion stays a human act ' +
    '(ADR-021).',
  exo_push_send:
    'A notification on somebody’s phone cannot be taken back, which is what irreversible means ' +
    'even though no data is lost.',
  exo_push_device_remove:
    'A push subscription the server has forgotten never comes back (ADR-048): the device has ' +
    'to subscribe again by hand, so removing one is irreversible in effect.',
};

/** Why a tool is not released, or `null` when it is. */
export type CompactWithholding =
  'person_only' | 'irreversible' | 'access' | 'standing_instruction' | 'open_web' | 'withheld';

export function compactWithholding(tool: AnyToolDefinition): CompactWithholding | null {
  if (tool.destructive || tool.irreversible) return 'irreversible';
  if (!tool.surfaces.includes('ai')) return 'person_only';
  if (WITHHELD_DOMAINS.includes(tool.domain)) return 'access';
  if (tool.mutating && STANDING_INSTRUCTION_DOMAINS.includes(tool.domain)) {
    return 'standing_instruction';
  }
  if (tool.untrustedOutput === 'web') return 'open_web';
  if (Object.hasOwn(COMPACT_WITHHELD, tool.name)) return 'withheld';
  return null;
}

/**
 * What `/api/mcp/compact` lists directly: its domains, and the few tools
 * named beside them with a reason (`COMPACT_ENDPOINT_ALSO_LISTED`).
 */
export function compactEndpointListed(): readonly AnyToolDefinition[] {
  return toolsFor('mcp', {
    domains: COMPACT_ENDPOINT_DOMAINS,
    alsoListed: COMPACT_ENDPOINT_ALSO_LISTED_NAMES,
  });
}

/**
 * The tools of the `mcp` surface the compact endpoint does not list and its
 * dispatchers may run. Computed once from the catalogue; a test pins the
 * result, so a new tool that would be released turns it red until somebody
 * decided it.
 */
export const COMPACT_ENDPOINT_EXECUTABLE: readonly string[] = (() => {
  const listed = new Set(compactEndpointListed().map((tool) => tool.name));
  return toolsFor('mcp')
    .filter((tool) => !listed.has(tool.name) && compactWithholding(tool) === null)
    .map((tool) => tool.name)
    .sort();
})();
