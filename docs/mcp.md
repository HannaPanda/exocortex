# MCP server

Exocortex is reachable from external MCP clients (Hermes, Claude Code, any
stdio-speaking client) and from its own built-in AI tool loop through the
*same* tool catalogue. This document covers the architecture, the tool
reference, how to add a tool, authentication, the confirmation gate, and how
to configure a client.

## What it is

One catalogue, two surfaces:

* **`packages/mcp-tools`** — the tool catalogue. Each tool is a name, a German
  description, a zod input schema, and an `execute(client, input)` that talks
  to the REST API through an injected `ExocortexApiClient`.
* **`apps/mcp`** — a ~400-line stdio JSON-RPC bin. It builds a `fetch`-based
  `ExocortexApiClient` from environment variables and dispatches
  `tools/list`/`tools/call` into the catalogue.
* **`apps/worker`** (brief 04) imports the *same* catalogue for the built-in
  AI's tool loop, authenticated with a short-lived service token instead of a
  persistent API token.

Because both surfaces read `packages/mcp-tools/src/catalog.ts`, adding a tool
in one place adds it to both at once — external MCP and the built-in AI can
never drift apart. This is the parity rule referenced from `CLAUDE.md`.

## Architecture

```
Hermes / Claude Code / any MCP client
        │  stdio, newline-delimited JSON-RPC 2.0
        ▼
   apps/mcp (this package)
        │  tools/list, tools/call
        ▼
 @exocortex/mcp-tools catalogue  ◄──── apps/worker's AI tool loop (brief 04)
        │  ExocortexApiClient.request/upload
        ▼
   apps/api (REST, bearer auth)
        │
        ▼
  packages/database, packages/queue, packages/storage, ...
```

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

All 29 tools are namespaced `exo_` so they cannot collide with the other MCP
servers Hermes spawns (`flauschibrain`, `flauschi-mcp`, `health-app`).

| Tool | Mutating | REST call |
| --- | --- | --- |
| `exo_list_workspaces` | no | `GET /api/workspaces` |
| `exo_page_tree` | no | `GET /api/workspaces/:workspaceId/documents/tree` |
| `exo_page_read` | no | `GET /api/documents/:documentId/export/markdown` (capped at 60,000 chars) |
| `exo_page_create` | yes | `POST /api/workspaces/:workspaceId/import/markdown` when `markdown` is given, else `POST /api/workspaces/:workspaceId/documents` |
| `exo_page_write` | yes | `POST /api/documents/:documentId/content` |
| `exo_page_rename` | yes | `PATCH /api/documents/:documentId` (title, icon) |
| `exo_page_move` | yes | `POST /api/documents/:documentId/move` |
| `exo_page_archive` | yes | `POST /api/documents/:documentId/archive` |
| `exo_page_restore` | yes | `POST /api/documents/:documentId/restore` |
| `exo_page_snapshots` | no | `GET /api/documents/:documentId/snapshots` |
| `exo_page_restore_snapshot` | yes | `POST /api/documents/:documentId/snapshots/:snapshotId/restore` |
| `exo_page_set_ai_rule` | yes | `PATCH /api/documents/:documentId` (aiRuleMode/Trigger/Priority) |
| `exo_page_set_layout` | yes | `PATCH /api/documents/:documentId` (layout: narrow/wide/full) |
| `exo_search` | no | `GET /api/workspaces/:workspaceId/search?q=&limit=&includeArchived=` |
| `exo_database_create` | yes | `POST /api/workspaces/:workspaceId/documents` (`type: 'COLLECTION'`) + one `POST .../properties` per requested column |
| `exo_database_schema` | no | `GET /api/documents/:documentId/properties` + `GET .../views` |
| `exo_database_property_create` | yes | `POST /api/documents/:documentId/properties` |
| `exo_database_property_update` | yes | `PATCH /api/documents/:documentId/properties/:propertyId` |
| `exo_database_property_delete` | yes | `DELETE /api/documents/:documentId/properties/:propertyId` |
| `exo_database_option_create` | yes | `POST /api/documents/:documentId/properties/:propertyId/options` |
| `exo_database_view_create` | yes | `POST /api/documents/:documentId/views` |
| `exo_database_view_update` | yes | `PATCH /api/documents/:documentId/views/:viewId` |
| `exo_database_view_delete` | yes | `DELETE /api/documents/:documentId/views/:viewId` |
| `exo_database_query` | no | `POST /api/documents/:documentId/rows/query` (Markdown table, capped at 50 rows) |
| `exo_database_row_create` | yes | `POST /api/documents/:documentId/rows` |
| `exo_database_row_update` | yes | `PATCH /api/documents/:rowId/values` |
| `exo_attachment_upload` | yes | `POST /api/workspaces/:workspaceId/attachments` (multipart, Base64 input) |
| `exo_attachment_read_text` | no | `GET /api/attachments/:attachmentId/text` (text plus PDF metadata), or `…/text/info` with `includeText: false` (metadata only, and no extraction is started) |
| `exo_rules_list` | no | `GET /api/workspaces/:workspaceId/ai-rules` |
| `exo_rules_load` | no | `GET /api/documents/:documentId/export/markdown` (capped at 60,000 chars) |

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

Two credential kinds resolve to a `VerifiedSession` in `apps/api`'s
`SessionGuard` (see `packages/auth/src/api-token.ts` and `service-token.ts`):

| Prefix | Who mints it | Lifetime | Used by |
| --- | --- | --- | --- |
| `exo_` | A user, via `POST /api/me/api-tokens` (brief 02) | Until revoked or its optional `expiresAt` | External MCP clients: `apps/mcp` via `EXOCORTEX_API_TOKEN` |
| `exos_` | The worker itself, per AI run (D3) | 300 seconds, HMAC-signed with `SERVICE_TOKEN_SECRET` | The built-in AI's tool loop |

Either way, a token carries **exactly its issuing user's permissions** — the
same workspace roles and policies a browser session would have. There is no
elevated "MCP" role. `ApiToken.scopes` is reserved for finer-grained scoping
but is not enforced yet (an empty array means "everything this user may do").

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
`apps/api` directly, bypassing nginx (and its HTTP basic auth) entirely.
`EXOCORTEX_BASIC_AUTH` (`user:password`) exists for a remote deployment behind
nginx basic auth, but cannot simply be sent as `Authorization` — the bearer
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
* **No comments or share-links API yet.** Nothing to wrap in a tool until
  those REST endpoints exist.
* **AI conversations are not in the catalogue at all**, by design rather than
  by omission: the catalogue is what an assistant may do *to a workspace*, and
  a conversation is the assistant's own session. An MCP client has its own
  transcript and its own context; handing it tools to steer Exocortex's side
  panel would be steering a second, unrelated chat. This is why the panel's
  slash commands (`/model`, `/think`, `/context`, …) have no tool counterparts.
  If a conversation-management API is ever wanted, it needs its own decision,
  not an incremental tool.
* **Two response shapes are defined locally, not in `@exocortex/contracts`.**
  See "Tool reference" above; `packages/contracts` was frozen for this wave.
