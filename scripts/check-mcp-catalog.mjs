#!/usr/bin/env node
/**
 * Gate: the MCP catalogue keeps up with the REST API.
 *
 * CLAUDE.md rule 11 and ADR-014: `packages/mcp-tools` is the one tool
 * catalogue, it serves both the external MCP server and the built-in AI's tool
 * loop, and it reaches the domain only through the REST API. So anything a
 * human can do in the application should be reachable through a tool, and the
 * mechanical shadow of that rule is: every route in `apps/api` is either called
 * by a tool, or listed below with a reason.
 *
 * This is the rule that gets broken most quietly, because nothing fails when a
 * feature ships with a controller and no tool. The UI keeps working and the
 * catalogue simply falls a little further behind, one endpoint at a time.
 *
 * Three ways to go red:
 *
 *   1. a route no tool calls and no exemption covers -- the catalogue fell
 *      behind the API,
 *   2. an exemption that matches no route -- the list is rotting, and a stale
 *      entry is a hole the next endpoint can slip through,
 *   3. a tool calling a route that does not exist -- a rename broke a tool, and
 *      nothing else in the repository would have noticed, because the
 *      catalogue talks to the API over HTTP and the type checker never sees
 *      the join.
 *
 * Route matching is by method and shape, with every parameter segment
 * flattened to `:x` -- the two sides name their parameters independently, and
 * position is what has to agree. Both sides are read by `lib/api-surface.mjs`,
 * shared with the capability-parity gate so the two cannot come to disagree
 * about what a route is.
 */

import {
  collectApiRoutes,
  collectCatalogueCalls,
  matchesRoutePattern,
} from './lib/api-surface.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';

/**
 * Routes that are deliberately not tools, each with the reason.
 *
 * A `*` at the end of a path matches the rest of it; everything else is an
 * exact match against `METHOD /path` with parameters written as `:x`.
 *
 * "Covered elsewhere" is a legitimate reason and appears several times: a
 * capability and a route are not the same thing, and the catalogue sometimes
 * reaches one capability through a different endpoint than the browser does.
 */
const EXEMPT = [
  // -- the transport itself ------------------------------------------------
  {
    route: '* /api/mcp*',
    reason:
      'The MCP transport (ADR-018). A tool cannot be its own transport, and a tool that called it would be a loop.',
  },
  {
    route: '* /api/auth*',
    reason:
      'Better Auth, proxied verbatim. Sign-in, sessions and OAuth are browser flows; an MCP client already arrives authenticated with a bearer token.',
  },
  {
    route: '* /.well-known*',
    reason:
      'OAuth discovery at the origin root (RFC 8414 and RFC 9728), the same Better Auth handler under a second mount. A client reads these documents before it has a credential, which is the opposite of a tool call.',
  },
  {
    route: 'GET /api/session',
    reason: 'Who the current cookie belongs to. An MCP caller knows who it is from its own token.',
  },
  {
    route: 'POST /api/features/seen',
    reason:
      "Moves one person's marker in the feature registry to the newest entry (issue #80). Reading the list is a tool (`exo_features`); marking it read is a statement about a human's attention, and an agent that called it would silently clear somebody else's badge. The read side has full parity.",
  },
  {
    route: '* /api/share/*',
    reason:
      'What a public share link serves (issue #83, ADR-044). Authenticated by a token in the path and by nothing else, so a tool calling it would be an agent reading a page it holds no credential for. Everything behind a link is reachable with a credential through the ordinary page routes, which have full parity.',
  },
  {
    route: '* /health*',
    reason: 'Liveness and readiness for monitoring and for deploy.sh, not a workspace capability.',
  },

  // -- the caller's own credentials ----------------------------------------
  {
    route: '* /api/me/api-tokens*',
    reason:
      'API tokens are minted in the browser, on purpose: a token that could mint further tokens would turn one leaked credential into permanent access.',
  },
  {
    route: '* /api/me/connections*',
    reason:
      'The list of OAuth clients a person has connected, and revoking one. Same reason: a client must not be able to manage its own authorization.',
  },

  // -- browser and editor plumbing -----------------------------------------
  {
    route: 'POST /api/documents/:x/collaboration-ticket',
    reason:
      'A short-lived ticket for the collaboration websocket (ADR-008). Only an editor session can use one.',
  },
  {
    route: 'GET /api/attachments/:x/download',
    reason:
      'Streams the raw bytes. MCP answers in text; `exo_attachment_read_text` is the readable half of the same attachment.',
  },
  {
    route: 'POST /api/documents/:x/cover',
    reason:
      'Uploads an image and sets it as the cover in one step, for drag-and-drop in the browser. Split in two for the catalogue: `exo_attachment_upload`, then `exo_page_set_cover`.',
  },

  // -- the built-in AI's own state -----------------------------------------
  {
    route: 'POST /api/ai/conversations',
    reason:
      'Starts a conversation. The caller of a tool is itself the assistant in one, so creating another is a loop. Reading the history is not: `exo_chat_list`, `exo_chat_search` and `exo_chat_read` cover that half (issue #69).',
  },
  {
    route: 'PATCH /api/ai/conversations/:x',
    reason:
      'Renames a conversation, switches its model, archives it. Settings of the panel the caller is talking through.',
  },
  {
    route: 'DELETE /api/ai/conversations/:x',
    reason: 'Archives a conversation. Same reason: the agent is inside one.',
  },
  {
    route: 'DELETE /api/ai/conversations/:x/permanent',
    reason:
      "Deletes a transcript irreversibly. The one thing no snapshot brings back, and the agent's own history is what it would reach first -- the same reason `exo_page_delete` is not on the AI surface.",
  },
  {
    route: 'POST /api/ai/conversations/:x/messages',
    reason:
      'Posts a message into a conversation. From inside a tool loop this is the assistant writing into its own transcript.',
  },
  {
    route: 'POST /api/ai/conversations/:x/sources',
    reason:
      'Pins a source to a conversation. Deciding what a conversation carries with it is the person saying what leaves their workspace, so a run that could pin a page would be widening its own context from inside itself -- the same argument that keeps `ai.untrustedContentPolicy` out of a request parameter (ADR-030). Reading the list is the opposite and is `exo_chat_context` (issue #75).',
  },
  {
    route: 'PATCH /api/ai/conversations/:x/sources/:x',
    reason:
      'Switches a pinned source between embedded and named-only. Same reason: that is the person choosing what a turn pays for, and `exo_chat_context` reports the answer.',
  },
  {
    route: 'DELETE /api/ai/conversations/:x/sources/:x',
    reason:
      'Unpins a source. Same reason, and the asymmetry is deliberate: a run that could quietly drop a source the person pinned would be editing the context it is being judged on.',
  },
  {
    route: 'POST /api/ai/conversations/:x/to-page',
    reason:
      "Saves a chat as a page. Covered elsewhere: an agent that wants a transcript as a page reads it with `exo_chat_read` and writes it with `exo_page_create`, and deciding that a conversation is worth keeping is the person's call (ADR-021 draws the same line for promoting a fact).",
  },
  {
    route: 'POST /api/ai/runs',
    reason:
      'Starts a run of the built-in AI. A tool that started one would have the AI call itself; `exo_ai_run_get` and `exo_ai_run_cancel` observe runs a human started.',
  },
  {
    route: 'GET /api/ai/models',
    reason:
      'Which models the chat panel may offer. The model is chosen before a tool loop starts, never from inside one.',
  },

  // -- deployment administration -------------------------------------------
  {
    route: '* /api/admin/settings*',
    reason:
      'Runtime configuration of the deployment (ADR-013). Deliberately out of reach of an agent: these keys decide what agents may do.',
  },
  {
    route: '* /api/workspaces/:x/settings*',
    reason:
      "One workspace's overrides of the runtime configuration (issue #52, ADR-023). Same reason as the deployment-wide form above, and it bites harder here: `ai.toolsEnabled`, `ai.mutatingToolsEnabled` and `ai.budgetMicroUsdPerRun` are among the overridable keys, so a tool for this would let an agent widen its own permissions and raise its own spending limit. A human sets this in the workspace settings.",
  },
  {
    route: '* /api/workspaces/:x/credentials*',
    reason:
      "A workspace's own provider key (issue #52, ADR-023). Same reason as `/api/me/api-tokens*`: a credential is entered by a human in a browser, and a tool that could store one would let an agent point the deployment's spending at a key nobody chose. Reading is no better -- the route answers with a hint and a date, which is exactly what an agent has no use for and an owner does.",
  },
  {
    route: '* /api/admin/ai-models*',
    reason:
      'The model registry. Same reason, and it is edited once in a while by a human in the admin area.',
  },
  { route: 'GET /api/admin/overview', reason: 'Dashboard counters for the admin area.' },
  {
    route: 'PATCH /api/admin/users/:x',
    reason:
      'Grants and revokes the deployment-wide admin role. `exo_user_set_disabled` and `exo_user_delete` cover the two operations an agent has any business performing.',
  },

  // -- invitations ---------------------------------------------------------
  {
    route: 'POST /api/invitations/preview',
    reason:
      'Reads an invitation by its token, unauthenticated, so the sign-up page can name the workspace before anyone has an account.',
  },
  {
    route: 'POST /api/invitations/accept',
    reason: 'Redeems an invitation and creates the account. Unauthenticated by definition.',
  },
  {
    route: '* /api/admin/invitations*',
    reason:
      'The deployment-wide view of the same invitations. `exo_invitation_*` reaches both this and the per-workspace route, picking by whether a workspaceId was given.',
  },
  {
    route: '* /api/workspaces/:x/invitations*',
    reason: 'Covered by `exo_invitation_create`, `_list`, `_resend` and `_revoke`.',
  },

  // -- workspaces and membership -------------------------------------------
  {
    route: 'POST /api/workspaces',
    reason:
      'Creating a workspace is a deliberate human act: it is the unit of sharing and of access, and an agent that could create one could create somewhere unobserved to put things.',
  },
  {
    route: 'GET /api/workspaces/:x',
    reason:
      'One workspace with its members. `exo_list_workspaces` gives an agent the ids it needs; the member list is a human concern.',
  },
  {
    route: 'PATCH /api/workspaces/:x/members/:x',
    reason: "Changes someone's role. Granting access is not delegated to agents.",
  },
  {
    route: 'DELETE /api/workspaces/:x/members/:x',
    reason:
      "Takes someone's access away, and ends their open sessions while doing it. The same reason as granting a role, read the other way round: an agent that could remove a member could lock a person out of their own workspace.",
  },

  // -- agent provenance ----------------------------------------------------
  {
    route: 'POST /api/agent-sessions/:x/revert',
    reason:
      'Takes back everything one agent session wrote. Listing and reading a session are tools (`exo_agent_session_list`, `exo_agent_session_get`); undoing it is not, because an agent that can revert an afternoon in one call is a new way to lose work, and whether a session was a mistake is not a judgement the agent that made it can make. A person presses this in the admin area (ADR-022).',
  },

  // -- covered through another route ---------------------------------------
  {
    route: 'POST /api/workspaces/:x/trash/deletion-preview',
    reason:
      'Bulk preview for "empty the trash" in the browser. `exo_page_delete` previews one page at a time, which is the granularity a tool call has.',
  },
  {
    route: 'POST /api/workspaces/:x/trash/delete',
    reason: 'Empties the whole trash in one click. Same reason, and irreversible in bulk.',
  },
  {
    route: 'POST /api/documents/:x/snapshots',
    reason:
      'Takes a snapshot by hand. Every write through `exo_page_write` already takes one first, so a tool never needs to ask.',
  },
  {
    route: 'DELETE /api/attachments/:x',
    reason:
      'Deleting an attachment is only reachable from the block that shows it; removing the block from the page is what `exo_page_write` does.',
  },
  {
    route: 'POST /api/memory/capture',
    reason:
      'The SessionEnd hook posts a whole transcript here to be condensed (ADR-019). `remember` is the deliberate half and is a tool; capture is machinery.',
  },
  {
    route: 'POST /api/entities/database',
    reason:
      'Creates the entity database and writes `entities.databaseId`, a deployment-wide setting that decides what every entity tool then reads (issue #47). Administrator-only and done once, like the rest of `/api/admin/settings`. The nine `exo_entity_*` tools cover everything past that point.',
  },
  {
    route: 'POST /api/memory/facts',
    reason:
      'Applies one nightly consolidation run (issue #46). It rewrites what the memory believes in a single call, for a job that has just read the notes it is judging; a model able to call it directly could rewrite its own past without a note saying so. Reading is `exo_memory_facts`, promoting is `exo_memory_fact_promote`.',
  },
];

// ---------------------------------------------------------------------------
// Comparing them
// ---------------------------------------------------------------------------

step('MCP catalogue completeness (apps/api routes ↔ packages/mcp-tools)');

const apiRoutes = collectApiRoutes();
const catalogueCalls = collectCatalogueCalls();

if (apiRoutes.size === 0) {
  fail(
    'No REST routes found in apps/api',
    [],
    'The controller scan matched nothing, which means this gate is measuring nothing. Check whether the @Controller decorator style changed.',
  );
}

const uncovered = [];
let coveredByTool = 0;
let coveredByExemption = 0;
for (const [route, where] of apiRoutes) {
  if (catalogueCalls.has(route)) {
    coveredByTool += 1;
    continue;
  }
  if (EXEMPT.some((entry) => matchesRoutePattern(route, entry.route))) {
    coveredByExemption += 1;
    continue;
  }
  uncovered.push(`${route}  (${where})`);
}

const stale = EXEMPT.filter(
  (entry) => ![...apiRoutes.keys()].some((route) => matchesRoutePattern(route, entry.route)),
).map((entry) => `${entry.route} — matches no route any more`);

const dangling = [...catalogueCalls]
  .filter(([route]) => !apiRoutes.has(route))
  .map(([route, where]) => `${route}  (called from ${where})`);

if (uncovered.length > 0) {
  fail(
    `${uncovered.length} REST route(s) have no tool in the catalogue`,
    uncovered,
    'Add the tool in packages/mcp-tools in the same commit series (recipe: docs/mcp.md), or add the route to EXEMPT in this script with the reason it is not a tool.',
  );
}

if (stale.length > 0) {
  fail(
    `${stale.length} exemption(s) in this script match nothing`,
    stale,
    'The route was renamed or removed. Delete the entry — an exemption that matches nothing is a hole the next endpoint slips through.',
  );
}

if (dangling.length > 0) {
  fail(
    `${dangling.length} tool call(s) point at a route that does not exist`,
    dangling,
    'The catalogue reaches the API over HTTP, so nothing else in the repository notices a renamed route. Fix the path in the tool.',
  );
}

info(
  `${apiRoutes.size} route(s): ${coveredByTool} called by a tool, ` +
    `${coveredByExemption} exempt through ${EXEMPT.length} documented reason(s)`,
);
ok('Every REST route is a tool or has a documented reason not to be.');
