# MCP server

eXocortex is reachable from external MCP clients (Hermes, Claude Code, ChatGPT,
any client that speaks stdio or Streamable HTTP) and from its own built-in AI
tool loop through the *same* tool catalogue. This document covers the
architecture, the two transports, the tool reference, how to add a tool,
authentication, the confirmation gate, and how to configure a client.

## What it is

One catalogue, several surfaces:

* **`packages/mcp-tools`** — the tool catalogue. Each tool is a name, a German
  description, a zod input schema, and an `execute(client, input)` that talks
  to the REST API through an injected `ExocortexApiClient`. It also owns the
  MCP method dispatch (`src/protocol.ts`), which is transport-free on purpose:
  both transports below run that same code and add only their own framing.
* **`apps/mcp`** — a small stdio JSON-RPC bin. It builds a `fetch`-based
  `ExocortexApiClient` from environment variables and hands messages to the
  shared dispatcher. Started as a subprocess by the client.
* **`apps/api`, `POST /api/mcp`** — the same protocol over HTTP
  ([ADR-018](adr/ADR-018-remote-mcp-over-http.md)), for clients that connect to
  a URL and cannot start a process. This is the only way ChatGPT can be
  connected.
* **`apps/worker`** (brief 04) imports the *same* catalogue for the built-in
  AI's tool loop, authenticated with a short-lived service token instead of a
  persistent API token.

The token an external client uses carries scopes (`docs/security.md`). A client
given a `read` token can call every tool in the "no" column of the table below
and will get `api_token_insufficient_scope` from the ones marked "yes". Give a
read-only client a read-only token; the catalogue does not need to know.

Because both surfaces read `packages/mcp-tools/src/catalog.ts`, adding a tool
in one place adds it to both at once — external MCP and the built-in AI can
never drift apart. This is the parity rule referenced from `CLAUDE.md`.

## Architecture

```
Hermes / Claude Code                        ChatGPT / any remote client
        │  stdio, newline-delimited                 │  Streamable HTTP,
        │  JSON-RPC 2.0                             │  bearer or OAuth
        ▼                                           ▼
   apps/mcp                                POST /api/mcp (apps/api)
        │                                           │
        └───────────────┬───────────────────────────┘
                        ▼
     @exocortex/mcp-tools: protocol dispatch + catalogue
                        │             ▲
                        │             └──── apps/worker's AI tool loop (brief 04)
                        │  ExocortexApiClient.request/upload
                        ▼
                 apps/api (REST, bearer auth)
                        │
                        ▼
   packages/database, packages/queue, packages/storage, ...
```

The HTTP endpoint's arrow back into `apps/api` is a real HTTP call, over
loopback to `127.0.0.1:3211`. The API answers its own request. That is one
extra hop per tool call, and it is what keeps the rule below true for the HTTP
transport as well: a tool cannot skip a policy check, because the check *is*
the same request a browser makes.

The catalogue **only** talks REST. It never imports `@exocortex/database`,
`@exocortex/auth` or `@exocortex/queue` directly (enforced by
`scripts/dependency-graph.mjs`: `@exocortex/mcp-tools` may depend on
`@exocortex/contracts` and nothing else). Three consequences:

1. **Authorization stays in `apps/api`.** Every tool call goes through the same
   `SessionGuard` and policy checks (`assertPolicy`) a human's browser request
   would. An MCP call can never take a shortcut past a permission check.
2. **Remote usability.** The same catalogue works against a local
   `127.0.0.1:3211` API or a remote `https://exocortex.app` deployment; only
   `EXOCORTEX_API_URL` changes.
3. **Structural parity.** The worker's tool loop and the external MCP server
   are two thin adapters around the same `AnyToolDefinition[]`. There is no
   second place to keep in sync.

`apps/mcp` hand-rolls the stdio JSON-RPC transport (`src/stdio.ts`) instead of
depending on `@modelcontextprotocol/sdk`: the protocol surface needed is three
methods plus `initialize`/`ping`, and owning the transport means owning stdout
discipline completely, which the SDK does not guarantee out of the box.

## Tool reference

All 46 tools below are namespaced `exo_` so they cannot collide with the other
MCP servers Hermes spawns (`flauschibrain`, `flauschi-mcp`, `health-app`). Two
further tools, `search` and `fetch`, live on a surface of their own and are
described under "ChatGPT deep research"; they are the only tools in the
catalogue without the prefix, because ChatGPT matches them by exact name.

Every entry in `tools/list` carries MCP annotations derived from the columns
below: `readOnlyHint` is the negation of "Mutating", `destructiveHint` is the
"Destructive" column, and `openWorldHint` is always false because no tool
reaches outside this deployment. They are not decoration. A client that keeps
write access behind its own opt-in reads `readOnlyHint` to decide which side of
that switch a tool belongs on, so a catalogue served without the hints arrives
as one undifferentiated block and tends to be used read-only.

"Destructive" is narrower than "Mutating": it means the call can remove content
or write over content a person authored. Creating, uploading, moving and
restoring are not destructive, and neither are the reversible metadata switches
(layout, cover, AI rule, resolving a comment), because marking a one-click
change as dangerous only trains people to click past the warnings that matter.

| Tool | Mutating | Destructive | REST call |
| --- | --- | --- | --- |
| `exo_list_workspaces` | no | no | `GET /api/workspaces` |
| `exo_workspace_rename` | yes | yes | `PATCH /api/workspaces/:workspaceId` (name and/or slug, independently) |
| `exo_page_tree` | no | no | `GET /api/workspaces/:workspaceId/documents/tree` |
| `exo_page_read` | no | no | `GET /api/documents/:documentId/export/markdown` (capped at 60,000 chars) |
| `exo_page_create` | yes | no | `POST /api/workspaces/:workspaceId/import/markdown` when `markdown` is given, else `POST /api/workspaces/:workspaceId/documents` |
| `exo_page_write` | yes | yes | `POST /api/documents/:documentId/content` |
| `exo_page_rename` | yes | yes | `PATCH /api/documents/:documentId` (title, icon, iconColor) |
| `exo_page_move` | yes | no | `POST /api/documents/:documentId/move` -- an optional `workspaceId` moves the whole subtree into a different workspace instead of just re-parenting within the current one |
| `exo_page_archive` | yes | yes | `POST /api/documents/:documentId/archive` |
| `exo_page_restore` | yes | no | `POST /api/documents/:documentId/restore` |
| `exo_page_snapshots` | no | no | `GET /api/documents/:documentId/snapshots` |
| `exo_page_restore_snapshot` | yes | yes | `POST /api/documents/:documentId/snapshots/:snapshotId/restore` |
| `exo_page_activity` | no | no | `GET /api/documents/:documentId/activity` -- the page's own history (issue #20): created, renamed, moved, archived, restored, restorable snapshots and condensed editing sessions, merged server-side. Not a compliance audit trail; see `docs/background-jobs.md`. |
| `exo_page_set_ai_rule` | yes | no | `PATCH /api/documents/:documentId` (aiRuleMode/Trigger/Priority) |
| `exo_page_set_layout` | yes | no | `PATCH /api/documents/:documentId` (layout: narrow/wide/full) |
| `exo_page_set_cover` | yes | no | `PATCH /api/documents/:documentId` (coverAttachmentId/coverPosition) |
| `exo_page_generate_cover` | yes | no | `POST /api/documents/:documentId/cover/generate` |
| `exo_page_resolve_link` | no | no | `GET /api/workspaces/:workspaceId/documents/resolve?documentId=&title=&includeArchived=&limit=` -- identity first, title as the fallback; `resolvedBy` says which answered |
| `exo_page_backlinks` | no | no | `GET /api/documents/:documentId/links` -- both directions of the reference index, including references to a title no page carries |
| `exo_comment_list` | no | no | `GET /api/documents/:documentId/comments?includeResolved=` -- threads with their replies, open ones first, and whether an anchored thread has been orphaned |
| `exo_comment_create` | yes | no | `POST /api/documents/:documentId/comments` -- page-wide without `blockId`, anchored to a block with one, a reply with `parentId` |
| `exo_comment_update` | yes | yes | `PATCH /api/comments/:commentId` -- the author's own body only |
| `exo_comment_resolve` | yes | no | `POST /api/comments/:commentId/resolve` (`resolved: false` reopens) |
| `exo_comment_delete` | yes | yes | `DELETE /api/comments/:commentId` -- takes a thread's replies with it |
| `exo_search` | no | no | `GET /api/workspaces/:workspaceId/search?q=&limit=&includeArchived=` |
| `exo_database_create` | yes | no | `POST /api/workspaces/:workspaceId/documents` (`type: 'COLLECTION'`) + one `POST .../properties` per requested column |
| `exo_database_schema` | no | no | `GET /api/documents/:documentId` (for `rowCount`) + `GET .../properties` + `GET .../views` |
| `exo_database_property_create` | yes | no | `POST /api/documents/:documentId/properties` |
| `exo_database_property_update` | yes | yes | `PATCH /api/documents/:documentId/properties/:propertyId` |
| `exo_database_property_delete` | yes | yes | `DELETE /api/documents/:documentId/properties/:propertyId` |
| `exo_database_option_create` | yes | no | `POST /api/documents/:documentId/properties/:propertyId/options` |
| `exo_database_view_create` | yes | no | `POST /api/documents/:documentId/views` |
| `exo_database_view_update` | yes | yes | `PATCH /api/documents/:documentId/views/:viewId` |
| `exo_database_view_delete` | yes | yes | `DELETE /api/documents/:documentId/views/:viewId` |
| `exo_database_query` | no | no | `POST /api/documents/:documentId/rows/query` (Markdown table, capped at 50 rows) |
| `exo_database_row_get` | no | no | `GET /api/documents/:documentId/row` -- values of the row this document id names, or `row: null` if it is not a row |
| `exo_database_row_create` | yes | no | `POST /api/documents/:documentId/rows` |
| `exo_database_row_update` | yes | yes | `PATCH /api/documents/:rowId/values` |
| `exo_attachment_upload` | yes | no | `POST /api/workspaces/:workspaceId/attachments` (multipart, Base64 input) |
| `exo_attachment_read_text` | no | no | `GET /api/attachments/:attachmentId/text` (text plus PDF metadata), or `…/text/info` with `includeText: false` (metadata only, and no extraction is started). Returns the human correction whenever one exists, never the raw machine text on its own. |
| `exo_attachment_reextract_text` | yes | yes | `POST /api/attachments/:attachmentId/text/reextract` -- forces a fresh extraction even when the current one is already `ready` (issue #2); a plain `exo_attachment_read_text` never does this |
| `exo_attachment_correct_text` | yes | yes | `PATCH /api/attachments/:attachmentId/text` -- writes a human correction, or clears one with `text: null` (issue #2) |
| `exo_rules_list` | no | no | `GET /api/workspaces/:workspaceId/ai-rules` |
| `exo_rules_load` | no | no | `GET /api/documents/:documentId/export/markdown` (capped at 60,000 chars) |
| `exo_ai_run_get` | no | no | `GET /api/ai/runs/:runId` -- status, model, `heartbeatAt`, tool rounds, error code and the answer so far (capped at 2,000 chars) |
| `exo_ai_run_cancel` | yes | no | `POST /api/ai/runs/:runId/cancel` -- refuses a run that has already finished |

`exo_page_write` reaches a page that somebody has open at that moment: the API
hands the change to the collaboration server, which applies it to the live
document, so it appears in the editor immediately and the session's autosave
carries it instead of overwriting it ([ADR-016](adr/ADR-016-writes-reach-the-live-session.md)).
The response says so in `appliedToLiveSession`. `append` and `prepend` insert
only the new content there, so a person typing in that session keeps what they
wrote; `replace` replaces, as asked.

Database property tools only accept `IMPLEMENTED_PROPERTY_TYPES` from
`@exocortex/contracts` (`RELATION`/`ROLLUP`/`FORMULA` are reserved and
rejected by the query engine), so a model is never told it can create a
property type the API will refuse.

Two response shapes referenced above
(`POST .../snapshots/:snapshotId/restore`, the properties/views list
endpoints, the `DELETE` `{ deleted: true }` shape) have no named export in
`@exocortex/contracts` yet — it is frozen for this wave. They are defined
locally in `packages/mcp-tools/src/local-schemas.ts`; folding them back into
contracts is a follow-up for whichever wave next touches `packages/contracts`.

## Recipe: adding a tool

1. **Confirm the REST endpoint exists.** If it does not, add it to `apps/api`
   first (a different PR/wave); this catalogue never bypasses REST.
2. **Add the definition** to the right `packages/mcp-tools/src/tools/*.ts` file
   with `defineTool({...})`, a German `description`, and an `inputSchema` reused
   from `@exocortex/contracts` wherever it fits (`z.object({...}).extend(x.shape)`
   to add a path parameter to a request schema).
3. **Set `mutating` and, if `mutating: true`, `target`** — a function from the
   validated input to a stable string identifying the write destination
   (`document:<id>`, `workspace:<id>`). Every mutating tool must define one; the
   catalogue test enforces this.
4. **Export it** from the domain file's array (e.g. `PAGE_TOOLS`) and make sure
   `catalog.ts` re-exports that array into `EXOCORTEX_TOOLS`.
5. **Extend `catalog.test.ts`** if the new tool needs a specific assertion
   beyond the blanket checks (unique `exo_`-prefixed name, ≥20-char German
   description, `z.toJSONSchema` succeeds, mutating ⇒ has a target). Add a
   focused test in `packages/mcp-tools/src/tools/*.test.ts` for anything with
   non-trivial formatting (truncation, table rendering, branching REST calls).
6. **No `apps/worker` change is needed.** The built-in AI tool loop reads
   `toolsFor('ai', ...)` from the same catalogue; the new tool appears there
   automatically once step 4 is done, gated by `ai.mutatingToolsEnabled` if it
   is mutating.

## Authentication

| Prefix | Who mints it | Lifetime | Used by |
| --- | --- | --- | --- |
| `exo_` | A user, via `POST /api/me/api-tokens` | Until revoked or its optional `expiresAt` | `apps/mcp` via `EXOCORTEX_API_TOKEN`, and `POST /api/mcp` directly |
| `exos_` | The worker, per AI run; the API, per MCP request from an OAuth client | 300 seconds (AI) / 120 seconds (MCP), HMAC-signed with `SERVICE_TOKEN_SECRET` | The built-in AI's tool loop; the HTTP endpoint's loopback calls |
| *(none)* | The OAuth authorization server, per authorization | 1 hour, refreshable for 30 days | ChatGPT and other remote connectors, against `POST /api/mcp` only |

A token carries **exactly its issuing user's permissions** — the same workspace
roles and policies a browser session would have. There is no elevated "MCP"
role.

`ApiToken.scopes` is enforced by `TokenScopeGuard` (`read`, `write`, `admin`,
cumulative; an empty list grants nothing). The HTTP endpoint passes an `exo_`
token straight through to its loopback calls, so a read-scoped token lists
every tool and gets `api_token_insufficient_scope` back from the writing ones.
Refuse the temptation to give an agent an `admin` token: nothing in the
catalogue needs it, and it is the one scope that can mint further tokens.

An OAuth access token carries no eXocortex scope — the OpenID scopes it holds
say nothing about pages. What limits it is the tool list its endpoint serves
(`/api/mcp/research` cannot write at all) and the fact that it opens no other
route in the API. Revoke a connector by setting `disabled` on its row in
`oauth_application`; the check runs on every use, so its existing tokens die
with it.

`POST /api/mcp` does **not** accept a cookie session, only a bearer token. A
cookie travels with any request a page can provoke, so accepting one would put
every mutating tool one cross-site request away.

## The HTTP transport

`POST /api/mcp` carries one JSON-RPC message per request and answers with the
result as JSON. There is no session id and no SSE stream: this server sends no
notifications and makes no requests of its own, so a stream would be an idle
socket, and being stateless is what lets any API process answer any request.
`GET` is refused with 405, `DELETE` answers 204 so a client that tidies up on
shutdown gets a plain "fine".

Two endpoints, differing only in which tools they serve:

| URL | Tools | For |
| --- | --- | --- | --- |
| `https://exocortex.app/api/mcp` | the 46 `exo_` tools | a general-purpose agent |
| `https://exocortex.app/api/mcp/research` | `search`, `fetch` | ChatGPT deep research |

`tools/call` resolves a name against the list the connection was served, so the
research endpoint cannot reach a writing tool by naming it.

A quick check with a token:

```bash
curl -sS https://exocortex.app/api/mcp \
  -H 'authorization: Bearer exo_...' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

### Connecting ChatGPT

ChatGPT cannot start a subprocess and has no field for a bearer token, so it
authenticates with OAuth: it discovers the authorization server from the
endpoint, registers itself (RFC 7591), and runs an authorization code flow with
PKCE. All of that is served by Better Auth's `mcp` plugin under
`/api/auth/mcp/*`, with the two discovery documents rewritten to the origin
root by nginx, where clients look for them:

* `/.well-known/oauth-protected-resource`
* `/.well-known/oauth-authorization-server`

In ChatGPT, add a connector with the URL `https://exocortex.app/api/mcp`
(or `.../api/mcp/research` for deep research) and pick OAuth. The browser lands
on `/anmelden` if signed out, then on `/verbinden`, which names the client and
what it is asking for. **Nothing is issued until that page is answered.**

The consent screen is not a formality. Client registration is open, as the
specification requires, so without it any website could redirect a signed-in
person to the authorization endpoint with a client it registered seconds
earlier and receive a working token in silence. Better Auth only shows the
screen when the client asks for it with `prompt=consent`, so the API adds that
parameter itself before the plugin sees the request (`forceConsentPrompt` in
`apps/api/src/auth/auth.service.ts`). If a consent screen ever appears that you
did not set off, the answer is "Ablehnen".

### ChatGPT deep research

Deep research requires two tools named exactly `search` and `fetch`, answering
with JSON in the text content rather than prose. They are thin: `search` fans
out over the same `/search` endpoint `exo_search` uses, across every workspace
the account belongs to, merges by rank and returns `{id, title, url}`; `fetch`
returns the same Markdown `exo_page_read` returns, plus the title, a citation
URL and metadata. They live on their own surface (`surfaces: ['research']`) so
no other client is offered two unprefixed names, and the full catalogue is not
dumped on a connector that works badly with more than a handful of tools.

## Confirmation gate

Mutating tools go through `WriteConfirmationGate`
(`packages/mcp-tools/src/confirm.ts`) unless
`EXOCORTEX_REQUIRE_WRITE_CONFIRMATION=false`. The pending key is derived
**server-side** from `sha256(toolName + '\n' + target + '\n' + stableStringify(payload))`,
never from a client-supplied token. The first call to a mutating tool records
a pending entry and returns a German confirmation prompt as a normal (non-error)
tool result; the model reads it and, if it still wants to proceed, calls the
exact same tool with the exact same arguments again, which consumes the
pending entry and lets the call through. A changed payload or target starts a
fresh pending cycle; an unconfirmed entry expires after 5 minutes.

The prompt text spells that out at length on purpose. A model that reads
"call it again with the same parameters" as "call it again" will reword its
Markdown between attempts, hash differently every time, conclude the *content*
is being rejected, and start changing things that were never the problem — in
one observed run it switched from `append` to `replace` and overwrote a whole
page (the automatic pre-write snapshot got it back). So the message states that
nothing was written, that a single differing character counts as a new
operation, and that the prompt is not a complaint about the payload.

This exists because flauschibrain shipped a confirmation gate keyed on a
client-supplied token **twice** — a scheme that lets a model confirm an
operation it never actually announced, because the client (not the server)
controls what "the same operation" means. Keying on the tool name, the
declared write target and a hash of the payload closes that off structurally:
a client cannot fabricate a confirmation for an operation it did not first
request, and cannot swap the payload between the announcement and the
confirmation.

To disable the gate for trusted automation (a script driving its own
workspace, a CI job), set `EXOCORTEX_REQUIRE_WRITE_CONFIRMATION=false` in that
client's environment. Do this per deployment of `apps/mcp`, not globally.

Over HTTP the gate is always on and there is no switch, because the endpoint is
shared: one client's convenience would be every other client's missing
safeguard. The gate lives in the API process and its key includes the user id,
so the announcement and the confirmation — two unrelated HTTP requests — pair
up per person and never across people.

## Configuring a client

`apps/mcp` reads `EXOCORTEX_API_URL` + `EXOCORTEX_API_TOKEN` from its process
environment (see `src/env.ts`); no config file. Mint a token with
`POST /api/me/api-tokens` (brief 02) or the equivalent seed/admin script, then:

**Hermes** (`~/.hermes/config.yaml`, `mcp_servers` section):

```yaml
mcp_servers:
  exocortex:
    command: node
    args: ['/var/www/exocortex/apps/mcp/dist/main.js']
    env:
      EXOCORTEX_API_URL: 'http://127.0.0.1:3211'
      EXOCORTEX_API_TOKEN: 'exo_...'
```

**Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "exocortex": {
      "command": "node",
      "args": ["/var/www/exocortex/apps/mcp/dist/main.js"],
      "env": {
        "EXOCORTEX_API_URL": "http://127.0.0.1:3211",
        "EXOCORTEX_API_TOKEN": "exo_..."
      }
    }
  }
}
```

`EXOCORTEX_API_URL=http://127.0.0.1:3211` is the intended value whenever the
MCP client runs on the same host as the API (Hermes does): it talks to
`apps/api` directly, bypassing nginx entirely.
`EXOCORTEX_BASIC_AUTH` (`user:password`) exists for a remote deployment that
puts an nginx basic auth realm in front of the API. `exocortex.app` no longer
does, so a remote client needs nothing but its bearer token. Where such a realm
exists, the credentials cannot simply be sent as `Authorization` — the bearer
token already needs that header. `apps/mcp` sends it as
`X-Forwarded-Authorization: Basic <base64>` instead; the nginx config in front
of a remote deployment would need an explicit rule translating that header
back into real basic auth before proxying to the API. That nginx-side change
is out of scope for this brief and is not configured on `exocortex.app` today
— treat `EXOCORTEX_BASIC_AUTH` as a documented, currently-inert field until
that nginx rule is added.

## Known gaps

* **No attachment listing tool.** `apps/api/src/attachments/attachments.controller.ts`
  has no `GET /api/workspaces/:workspaceId/attachments` route (checked against
  the live controller before writing `exo_attachment_*`), so `exo_attachment_list`
  from the original plan was dropped rather than guessed at. Adding the list
  route is a follow-up for whoever next touches `apps/api/src/attachments`.
* **No download-URL tool.** `GET /api/attachments/:attachmentId/download` streams
  the file's bytes directly (it is not a JSON response with a presigned URL and
  metadata), which does not fit this catalogue's JSON-only tool-result model.
  The presigned URL is still reachable through `exo_attachment_upload`'s
  response at upload time; fetching a fresh one for an already-uploaded
  attachment requires either a new `apps/api` route or downloading through the
  web app.
* **No share-links API yet.** Nothing to wrap in a tool until those REST
  endpoints exist. (Comments used to stand here too; they exist since issue #18
  and are in the table above.)

  The comment tools are the catalogue's answer to a problem `exo_page_write`
  cannot solve: an assistant asked to review a page has, until now, had only
  one way to say something — by changing the page. `exo_comment_create` lets it
  say the same thing next to the text instead, and leaves the decision with
  whoever wrote it. `blockId` comes from `exo_page_read`, whose `^id` suffixes
  are the same identifiers, so "the third paragraph" never has to be described
  in prose. An anchored thread whose block is later deleted is **not** deleted
  with it: materialization marks it orphaned and `exo_comment_list` says so,
  along with the quote taken when the thread was opened.
* **AI conversations are not in the catalogue at all**, by design rather than
  by omission: the catalogue is what an assistant may do *to a workspace*, and
  a conversation is the assistant's own session. An MCP client has its own
  transcript and its own context; handing it tools to steer eXocortex's side
  panel would be steering a second, unrelated chat. This is why the panel's
  slash commands (`/model`, `/think`, `/context`, …) have no tool counterparts.
  If a conversation-management API is ever wanted, it needs its own decision,
  not an incremental tool.

  A run's *lifecycle* is the deliberate exception (issue #6). "Is this run
  still alive, and can I stop it?" is a question about a job, not about
  somebody else's chat, and it is the whole point of that issue that the
  answer must be reachable from outside the browser panel too. Hence
  `exo_ai_run_get` and `exo_ai_run_cancel` — and hence both are declared
  `surfaces: ['mcp']` and are the only tools in the catalogue that the
  built-in AI does not get. A tool loop with a cancel button has, first of
  all, the button that cancels itself.
* **Two response shapes are defined locally, not in `@exocortex/contracts`.**
  See "Tool reference" above; `packages/contracts` was frozen for this wave.
