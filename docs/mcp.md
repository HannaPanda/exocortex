# MCP server

eXocortex is reachable from external MCP clients (Hermes, Claude Code, ChatGPT,
any client that speaks stdio or Streamable HTTP) and from its own built-in AI
tool loop through the _same_ tool catalogue. This document covers the
architecture, the two transports, the tool reference, the resources and prompts
served beside it, how to add a tool, authentication, the confirmation gate, and
how to configure a client.

## What it is

One catalogue, several surfaces:

- **`packages/mcp-tools`** — the tool catalogue. Each tool is a name, a German
  description, a zod input schema, and an `execute(client, input)` that talks
  to the REST API through an injected `ExocortexApiClient`. It also owns the
  MCP method dispatch (`src/protocol.ts`), which is transport-free on purpose:
  both transports below run that same code and add only their own framing.
  `src/resources.ts` and `src/prompts.ts` sit beside it and serve the halves of
  the protocol a person drives rather than the model.
- **`apps/mcp`** — a small stdio JSON-RPC bin. It builds a `fetch`-based
  `ExocortexApiClient` from environment variables and hands messages to the
  shared dispatcher. Started as a subprocess by the client.
- **`apps/api`, `POST /api/mcp`** — the same protocol over HTTP
  ([ADR-018](adr/ADR-018-remote-mcp-over-http.md)), for clients that connect to
  a URL and cannot start a process. This is the only way ChatGPT can be
  connected.
- **`apps/worker`** (brief 04) imports the _same_ catalogue for the built-in
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
transport as well: a tool cannot skip a policy check, because the check _is_
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

### Instructions at `initialize`

The handshake answers with an `instructions` string, and every client that has
a system prompt puts it there. Two things go into it
(`packages/mcp-tools/src/instructions.ts`):

1. **How pages are filed.** Structure is content here: where a page hangs is
   part of what it says. A client that creates pages knows the page and nothing
   about the shelf, and the failure is always the same shape -- the page lands
   directly under the top-level section although the sub-section it belongs in
   sits one level below. The text says to look first (`exo_search`,
   `exo_page_tree` with a `parentId`) and to ask `exo_page_suggest_parent` when
   in doubt.
2. **The workspace's own rule pages.** A page with `aiRuleMode: ALWAYS` used to
   reach the built-in AI's system prompt and nothing else, so the deployment's
   own rules were invisible to exactly the clients that file the most pages.
   The `ALWAYS` pages are inlined in full, up to 8,000 characters across all
   workspaces; `ON_DEMAND` rules contribute their trigger sentence and the id
   `exo_rules_load` takes. "Always" is the whole claim, which is why those
   bodies are carried rather than pointed at.

Assembly never fails the handshake and never hangs it: a five second budget and
a catch around every call leave the base text standing. The two tiny surfaces
shaped for one foreign client each (research, memory) are served no
instructions at all -- a catalogue without `exo_page_create` has no pages to
file.

`apps/mcp` hand-rolls the stdio JSON-RPC transport (`src/stdio.ts`) instead of
depending on `@modelcontextprotocol/sdk`: the protocol surface needed is a
handful of methods around `initialize`/`ping`, and owning the transport means
owning stdout discipline completely, which the SDK does not guarantee out of
the box.

## Tool reference

Every tool below is namespaced `exo_` so they cannot collide with the other
MCP servers Hermes spawns (`flauschibrain`, `flauschi-mcp`, `health-app`). Four
further tools live on surfaces of their own and are the only ones in the
catalogue without the prefix: `search` and `fetch` for deep research, which
ChatGPT matches by exact name, and `recall` and `remember` on the memory
surface. Both surfaces are described below.

Every entry in `tools/list` carries MCP annotations derived from the columns
below: `readOnlyHint` is the negation of "Mutating", `destructiveHint` is the
"Destructive" column, and `openWorldHint` is false for every tool that acts on
this deployment's own workspaces -- which is all of them except the web-research
pair, whose results come from an open-ended set of servers we do not run. They are not decoration. A client that keeps
write access behind its own opt-in reads `readOnlyHint` to decide which side of
that switch a tool belongs on, so a catalogue served without the hints arrives
as one undifferentiated block and tends to be used read-only.

"Destructive" is narrower than "Mutating": it means the call can remove content
or write over content a person authored. Creating, uploading, moving and
restoring are not destructive, and neither are the reversible metadata switches
(layout, cover, AI rule, resolving a comment), because marking a one-click
change as dangerous only trains people to click past the warnings that matter.

A third property is orthogonal to both and is about what a tool _returns_
rather than what it changes: `untrustedOutput` marks a tool whose result
carries text from outside this deployment: `exo_attachment_read_text`,
`exo_web_search` and `exo_web_fetch`. The external surfaces ignore it; in the
built-in AI's loop it fences the result as data and closes the door on mutating
tools for the rest of that run (ADR-030, `docs/ai-architecture.md`).

| Tool                            | Mutating | Destructive | REST call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exo_list_workspaces`           | no       | no          | `GET /api/workspaces`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_workspace_overview`        | no       | no          | `GET /api/workspaces/:workspaceId/overview` -- recency, databases, sections and loose ends in one answer; the cheap first call for "what was worked on here" without pulling a whole tree                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_workspace_rename`          | yes      | yes         | `PATCH /api/workspaces/:workspaceId` (name and/or slug, independently)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_page_tree`                 | no       | no          | `GET /api/workspaces/:workspaceId/documents/tree` -- the text answer is the indented tree with ids, capped at 300 pages. The cap is spent breadth-first, so an oversized workspace loses its deepest level rather than its last sections; archived pages are counted, not listed                                                                                                                                                                                                                                                                                                                                                            |
| `exo_page_read`                 | no       | no          | `GET /api/documents/:documentId/export/markdown`, with a budget on it: above 10,000 characters the route answers with the page's **map** instead of its text, and `view` says which came back (issue #118). `transclusions: 'text'` puts the embedded sources' text in place of the `:::transclusion` references, for an export that leaves this deployment. `includeBlockIds: true` writes each block's identifier after it as `^id`, which is the address the three narrow writes take (issue #111)                                                                                                                                       |
| `exo_page_block_read`           | no       | no          | `GET /api/documents/:documentId/fragment` -- one block of a page instead of the whole page (issue #78, ADR-045). Without `blockId` the page's map: its sections with heading, size and block identifier. With one, that section's Markdown, or -- when the section is itself over the budget -- the map of _it_, down to block windows (`blockId` plus `toBlockId`) for a part that has no inner headings. `blocks: true` still returns the flat list of every addressable block with a preview. A heading addresses its whole section. The way to read a long page one section at a time, and the address a `:::transclusion` block embeds |
| `exo_page_create`               | yes      | no          | `POST /api/workspaces/:workspaceId/import/markdown` when `markdown` is given, else `POST /api/workspaces/:workspaceId/documents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_page_suggest_parent`       | no       | no          | `POST /api/workspaces/:workspaceId/documents/suggest-parent` -- where a page belongs, answered from the pages that already exist: the nearest neighbours are looked up through the search adapter and the parents they sit under are ranked. Answers with candidates, their path, how many pages already hang there and which neighbours argued for them. Writes nothing                                                                                                                                                                                                                                                                    |
| `exo_page_write`                | yes      | yes         | `POST /api/documents/:documentId/content` -- the whole page. An image must point at `/api/attachments/<id>/download`; a foreign host is answered with a warning, because the browser refuses to load it (issue #117)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_page_block_update`         | yes      | no          | `POST /api/documents/:documentId/content/block` (issue #111, ADR-055) -- replaces exactly one block, or inserts before/after it. Everything else on the page keeps its identifier, its position and any concurrent edit                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exo_page_patch`                | yes      | no          | `POST /api/documents/:documentId/content/patch` -- replaces a piece of text, matched against the page's Markdown. Zero or several matches write nothing and say how many there were; `replaceAll` is the deliberate exception                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_page_section_write`        | yes      | no          | `POST /api/documents/:documentId/content/section` -- writes under a heading. `replace` swaps the section's body and leaves the heading, because the heading is the address. A heading that occurs twice is refused with both block identifiers                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_page_extract_section`      | yes      | no          | `POST /api/documents/:documentId/content/extract-section` (issue #118) -- moves a section onto a page of its own in one call: the new page is created, the blocks are copied out of the canonical Yjs state with fresh identifiers, and a link, a transclusion or nothing stays behind. The address is the one `exo_page_block_read` hands out; `toBlockId` moves a window of blocks that has no heading. `targetDocumentId` appends to an existing page instead. The source page is snapshotted first                                                                                                                                      |
| `exo_page_rename`               | yes      | yes         | `PATCH /api/documents/:documentId` (title, icon, iconColor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_page_move`                 | yes      | no          | `POST /api/documents/:documentId/move` -- an optional `workspaceId` moves the whole subtree into a different workspace instead of just re-parenting within the current one                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_page_archive`              | yes      | yes         | `POST /api/documents/:documentId/archive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_page_restore`              | yes      | no          | `POST /api/documents/:documentId/restore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_page_trash`                | no       | no          | `GET /api/workspaces/:workspaceId/trash` (issue #32) -- the trash as a tree: what was archived, what came along with it (`reason: cascade`) and when. Capped at 200 lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_page_delete`               | yes      | yes         | `DELETE /api/documents/:documentId` (issue #31) -- irreversible, archived pages only, ADMIN or OWNER. Offered on `mcp` only, never to the built-in AI: that surface has no confirmation gate, only the `ai.mutatingToolsEnabled` switch, and the one operation nothing can undo does not belong behind a switch somebody flipped once. The first call answers with what the deletion would take with it (`GET .../deletion-preview`) and executes nothing                                                                                                                                                                                   |
| `exo_page_snapshots`            | no       | no          | `GET /api/documents/:documentId/snapshots`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_page_restore_snapshot`     | yes      | yes         | `POST /api/documents/:documentId/snapshots/:snapshotId/restore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `exo_page_snapshot_diff`        | no       | no          | `GET /api/documents/:documentId/snapshots/:snapshotId/diff?against=` (issue #77) -- blockwise comparison against a second snapshot or the current content, matched on stable block identifiers so a moved block is reported as moved. The identifiers in the answer are what `exo_page_restore_blocks` takes                                                                                                                                                                                                                                                                                                                                |
| `exo_page_restore_blocks`       | yes      | yes         | `POST /api/documents/:documentId/snapshots/:snapshotId/restore-blocks` (issue #77) -- takes single blocks back into the _current_ content instead of resetting the page. Per identifier the snapshot decides: present there it is written into the page, absent there it is taken out. Not irreversible: the state before is snapshotted first                                                                                                                                                                                                                                                                                              |
| `exo_page_activity`             | no       | no          | `GET /api/documents/:documentId/activity` -- the page's own history (issue #20): created, renamed, moved, archived, restored, restorable snapshots and condensed editing sessions, merged server-side. Not a compliance audit trail; see `docs/background-jobs.md`.                                                                                                                                                                                                                                                                                                                                                                         |
| `exo_page_set_ai_rule`          | yes      | no          | `PATCH /api/documents/:documentId` (aiRuleMode/Trigger/Priority)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_page_set_layout`           | yes      | no          | `PATCH /api/documents/:documentId` (layout: narrow/wide/full)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_page_set_cover`            | yes      | no          | `PATCH /api/documents/:documentId` (coverAttachmentId/coverPosition)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_page_generate_cover`       | yes      | no          | `POST /api/documents/:documentId/cover/generate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_page_resolve_link`         | no       | no          | `GET /api/workspaces/:workspaceId/documents/resolve?documentId=&title=&includeArchived=&limit=` -- identity first, title as the fallback; `resolvedBy` says which answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_capture`                   | yes      | no          | `POST /api/workspaces/:workspaceId/capture` -- a thought, a snippet, a link, filed nowhere: the entry lands in the workspace's inbox and is sorted later. The first line becomes the title unless one is given, and the inbox page is created by the first call that needs it                                                                                                                                                                                                                                                                                                                                                               |
| `exo_clip`                      | yes      | no          | `POST /api/workspaces/:workspaceId/clip` -- a web page kept as an ordinary page in the inbox: address, title and the selected text, with the provenance as the first line. `fetchPage: true` reads the page in the Steel browser as well, through the same address check as `exo_web_fetch`. Carries the web fence, so a run writes nothing after it                                                                                                                                                                                                                                                                                        |
| `exo_inbox`                     | no       | no          | `GET /api/workspaces/:workspaceId/inbox` -- what is still waiting to be filed, newest first, with the inbox's own id so the entries can be read and moved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_template_list`             | no       | no          | `GET /api/workspaces/:workspaceId/templates` -- the page templates of a workspace (issue #79, ADR-039), recently used first. A template is an ordinary page that was marked as one, so its `documentId` is the only id it has                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_template_create`           | yes      | no          | `POST /api/workspaces/:workspaceId/templates` -- marks an existing page as a template, with an optional description, title pattern and suggested target. The page stays where it is and stays a page                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_template_update`           | yes      | no          | `PATCH /api/templates/:documentId` -- description, title pattern, target parent; `null` clears one. The template's content is edited with `exo_page_write` like any page                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exo_template_delete`           | yes      | yes         | `DELETE /api/templates/:documentId` -- unmarks the page. Neither the page nor anything made from it is deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_template_use`              | yes      | no          | `POST /api/templates/:documentId/pages` -- a new page holding a copy of the template: content, icon, cover and, within the same database, the row properties. No link back afterwards                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_page_backlinks`            | no       | no          | `GET /api/documents/:documentId/links` -- both directions of the reference index, including references to a title no page carries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `exo_page_related`              | no       | no          | `GET /api/documents/:documentId/related` -- pages that resemble this one without being linked to it (issue #33), from the stored embeddings; `state` says whether the answer is `ready`, `pending` (page not embedded yet) or `disabled` (semantic search off)                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_comment_list`              | no       | no          | `GET /api/documents/:documentId/comments?includeResolved=` -- threads with their replies, open ones first, and whether an anchored thread has been orphaned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_comment_create`            | yes      | no          | `POST /api/documents/:documentId/comments` -- page-wide without `blockId`, anchored to a block with one, a reply with `parentId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_comment_update`            | yes      | yes         | `PATCH /api/comments/:commentId` -- the author's own body only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_comment_resolve`           | yes      | no          | `POST /api/comments/:commentId/resolve` (`resolved: false` reopens)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `exo_comment_delete`            | yes      | yes         | `DELETE /api/comments/:commentId` -- takes a thread's replies with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_share_list`                | no       | no          | `GET /api/documents/:documentId/shares` -- who can reach this page from outside, plus the grants it inherits from a shared section above it (issue #83, ADR-044). Never the raw link, only its first characters                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `exo_share_inherited`           | no       | no          | `GET /api/documents/:documentId/inherited-shares` -- what a page moved under this one would be shared by. Ask before `exo_page_move` into a section somebody else owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_share_workspace_list`      | no       | no          | `GET /api/workspaces/:workspaceId/shares` -- everything this workspace has handed out, withdrawn grants included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_shared_with_me`            | no       | no          | `GET /api/me/shares` -- pages other accounts shared with this one, across workspaces. They are in no page tree, because this account is not a member there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_share_create`              | yes      | no          | `POST /api/documents/:documentId/shares` -- `kind: 'USER'` with an `email`, or `kind: 'PUBLIC_LINK'` for an address anybody can open (always read-only). Confirmed twice: revoking a link afterwards does not unread the page. The raw address is in this one response and nowhere else                                                                                                                                                                                                                                                                                                                                                     |
| `exo_share_update`              | yes      | no          | `PATCH /api/shares/:shareId` -- permission, scope, expiry. Re-authorizes open connections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_share_revoke`              | yes      | no          | `DELETE /api/shares/:shareId` -- immediate, including for somebody who has the page open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exo_search`                    | no       | no          | `GET /api/workspaces/:workspaceId/search?q=&limit=&includeArchived=`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_saved_query_list`          | no       | no          | `GET /api/workspaces/:workspaceId/saved-queries` -- the stored questions of a workspace (issue #74, ADR-042), smart views first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `exo_saved_query_get`           | no       | no          | `GET /api/saved-queries/:savedQueryId` -- the full definition, which is what an update has to send back whole                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_saved_query_preview`       | no       | no          | `POST /api/workspaces/:workspaceId/saved-queries/preview` -- runs a definition without storing it. The filtering sibling of `exo_search`: place, type, properties, entities and time window                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_saved_query_run`           | no       | no          | `GET /api/saved-queries/:savedQueryId/results?limit=` -- answered fresh, with the caller's own access, never a stored list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_saved_query_create`        | yes      | no          | `POST /api/workspaces/:workspaceId/saved-queries` (`inSidebar: true` makes it a smart view everybody sees)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_saved_query_update`        | yes      | no          | `PATCH /api/saved-queries/:savedQueryId` -- `definition` is replaced whole                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_saved_query_reorder`       | yes      | no          | `POST /api/saved-queries/:savedQueryId/position` -- names the neighbour, not an index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_saved_query_delete`        | yes      | yes         | `DELETE /api/saved-queries/:savedQueryId` -- deletes the question; every page it found stays where it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exo_web_search`                | no       | no          | `POST /api/workspaces/:workspaceId/research/search` -- the open web through a self-hosted SearXNG. Returns addresses and snippets, never page text, and names the engines that did not answer (ADR-033)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exo_web_fetch`                 | no       | no          | `POST /api/workspaces/:workspaceId/research/fetch` -- one page, rendered in a Steel browser, as Markdown. http(s) and publicly resolvable addresses only; the run's own budget is `ai.webResearchMaxFetchesPerRun`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `exo_database_create`           | yes      | no          | `POST /api/workspaces/:workspaceId/documents` (`type: 'COLLECTION'`) + one `POST .../properties` per requested column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_database_schema`           | no       | no          | `GET /api/documents/:documentId` (for `rowCount`) + `GET .../properties` + `GET .../views`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_database_property_create`  | yes      | no          | `POST /api/documents/:documentId/properties`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_database_property_update`  | yes      | yes         | `PATCH /api/documents/:documentId/properties/:propertyId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_database_property_delete`  | yes      | yes         | `DELETE /api/documents/:documentId/properties/:propertyId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_database_option_create`    | yes      | no          | `POST /api/documents/:documentId/properties/:propertyId/options`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_database_option_update`    | yes      | yes         | `PATCH /api/documents/:documentId/properties/:propertyId/options/:optionId` -- renames or recolours one option; rows that had it keep it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exo_database_option_delete`    | yes      | yes         | `DELETE /api/documents/:documentId/properties/:propertyId/options/:optionId` -- rows that had it lose the value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `exo_database_property_reorder` | yes      | no          | `POST /api/documents/:documentId/properties/:propertyId/reorder` -- what dragging a column header does (ADR-025)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_database_view_create`      | yes      | no          | `POST /api/documents/:documentId/views`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exo_database_view_update`      | yes      | yes         | `PATCH /api/documents/:documentId/views/:viewId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_database_view_reorder`     | yes      | no          | `POST /api/documents/:documentId/views/:viewId/reorder` -- the order of the tabs above a database; the first one is what opens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_database_view_delete`      | yes      | yes         | `DELETE /api/documents/:documentId/views/:viewId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `exo_database_query`            | no       | no          | `POST /api/documents/:documentId/rows/query` (Markdown table, capped at 50 rows)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_database_row_get`          | no       | no          | `GET /api/documents/:documentId/row` -- values of the row this document id names, or `row: null` if it is not a row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `exo_database_row_create`       | yes      | no          | `POST /api/documents/:documentId/rows`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_database_row_update`       | yes      | yes         | `PATCH /api/documents/:rowId/values`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_attachment_upload`         | yes      | no          | `POST /api/workspaces/:workspaceId/attachments` (multipart, Base64 input). The response carries `embedUrl`, and that is the one that goes into a page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_attachment_upload_url`     | yes      | no          | `POST /api/workspaces/:workspaceId/attachments/from-url` (issue #117) -- eXocortex fetches the address and stores what it served. Carries the web fence (`untrustedOutput: 'web'`), because the bytes come from outside this deployment                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exo_attachment_read_text`      | no       | no          | `GET /api/attachments/:attachmentId/text` (text plus PDF metadata), or `…/text/info` with `includeText: false` (metadata only, and no extraction is started). Returns the human correction whenever one exists, never the raw machine text on its own.                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_attachment_reextract_text` | yes      | yes         | `POST /api/attachments/:attachmentId/text/reextract` -- forces a fresh extraction even when the current one is already `ready` (issue #2); a plain `exo_attachment_read_text` never does this                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_attachment_correct_text`   | yes      | yes         | `PATCH /api/attachments/:attachmentId/text` -- writes a human correction, or clears one with `text: null` (issue #2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_rules_list`                | no       | no          | `GET /api/workspaces/:workspaceId/ai-rules`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_rules_load`                | no       | no          | `GET /api/documents/:documentId/export/markdown` (capped at 60,000 chars)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_ai_run_get`                | no       | no          | `GET /api/ai/runs/:runId` -- status, model, `heartbeatAt`, tool rounds, error code and the answer so far (capped at 2,000 chars)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_ai_run_cancel`             | yes      | no          | `POST /api/ai/runs/:runId/cancel` -- refuses a run that has already finished                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_ai_usage`                  | no       | no          | `GET /api/admin/ai-usage` -- the deployment's AI usage over a range: runs by status, success rate, cost with the reported and estimated halves kept apart, tokens, duration percentiles, per model and per error code (issue #10). Needs admin rights                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_invitation_list`           | no       | no          | `GET /api/admin/invitations`, or `GET /api/workspaces/:workspaceId/invitations` when `workspaceId` is given                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_invitation_create`         | yes      | no          | `POST /api/admin/invitations` or `POST /api/workspaces/:workspaceId/invitations`, chosen by `via` -- the link is in the response only, and `emailSent: false` means it has to be handed over by hand                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_invitation_resend`         | yes      | yes         | `POST …/invitations/:invitationId/resend` -- rotates the token, so the previous link dies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_invitation_revoke`         | yes      | yes         | `DELETE …/invitations/:invitationId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_user_list`                 | no       | no          | `GET /api/admin/users`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_user_set_disabled`         | yes      | yes         | `PATCH /api/admin/users/:userId/status` -- ends every session and revokes every token of that account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_user_delete`               | yes      | yes         | `DELETE /api/admin/users/:userId` -- only for an account that authored nothing, else `user_has_content`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exo_chat_list`                 | no       | no          | `GET /api/ai/conversations` -- the caller's own chats, across every workspace they are a member of; `archived` is three-valued, `cursor` pages (issue #69)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_chat_search`               | no       | no          | `GET /api/ai/conversations/search` -- full text over the messages, one hit per conversation with the matching passage. Finds a chat from weeks ago by a word out of it                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_chat_read`                 | no       | no          | `GET /api/ai/conversations/:conversationId` -- the whole transcript, retired messages included and marked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_chat_context`              | no       | no          | `GET /api/ai/conversations/:conversationId/sources` -- what the conversation has pinned beside the open page: title, kind, whether the text goes out or only the name, and what it costs in characters (issue #75, ADR-043). Pinning itself is not a tool                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_agent_session_list`        | no       | no          | `GET /api/agent-sessions` -- the caller's own agent sessions, or all of them for a global admin (ADR-022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_agent_session_get`         | no       | no          | `GET /api/agent-sessions/:sessionId` -- what one session wrote, and whether each write left a state to go back to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `exo_automation_list`           | no       | no          | `GET /api/workspaces/:workspaceId/automations` -- the rules, plus whether automations run here at all and which hosts a webhook may reach (issue #50, ADR-024)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_automation_create`         | yes      | no          | `POST /api/workspaces/:workspaceId/automations` -- OWNER only, `admin` token scope. A webhook rule's signing secret is in this response and nowhere else, ever                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_automation_update`         | yes      | no          | `PATCH /api/automations/:ruleId` -- the merged rule is validated, not the patch; `enabled: false` is the per-rule emergency stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exo_automation_delete`         | yes      | yes         | `DELETE /api/automations/:ruleId` -- takes the run log with it. For switching a rule off, use `exo_automation_update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exo_automation_runs`           | no       | no          | `GET /api/workspaces/:workspaceId/automations/runs` -- what the automations did, why a run failed, how long it took. The way to debug a rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_automation_trigger`        | yes      | no          | `POST /api/automations/:ruleId/trigger` -- fires a rule against one page without the debounce. It really acts: the webhook goes out, the model is paid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exo_push_devices`              | no       | no          | `GET /api/me/push/devices` -- the devices this account can be notified on, what each one accepts and when it was last reached (issue #30, ADR-048). Registering one is deliberately not a tool: a subscription is minted by a browser's own push service                                                                                                                                                                                                                                                                                                                                                                                    |
| `exo_push_device_update`        | yes      | no          | `PATCH /api/me/push/devices/:deviceId` -- renames a device or replaces the kinds it accepts. An empty list leaves it registered and silent, which is the mild way to stop a device buzzing                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_push_device_remove`        | yes      | no          | `DELETE /api/me/push/devices/:deviceId` -- for a device that is gone. It can only come back through a browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_push_send`                 | yes      | no          | `POST /api/me/push/send` -- puts a line on the caller's own devices, with an optional link inside this deployment. `devices: 0` means nobody heard it. Never reaches another account's devices                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_render_template_list`      | no       | no          | `GET /api/workspaces/:workspaceId/render/templates` -- the ways this workspace turns pages into files, and whether rendering runs here at all (issue #44, ADR-026)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `exo_render_template_read`      | no       | no          | `GET /api/render/templates/:templateId` -- the template with its full source, so a change starts from what is there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `exo_render_template_create`    | yes      | no          | `POST /api/workspaces/:workspaceId/render/templates` -- ADMIN. `source: null` uses the built-in Eisvogel template and needs no LaTeX                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_render_template_update`    | yes      | no          | `PATCH /api/render/templates/:templateId` -- every page built with it looks different from then on, and the PDFs already built become stale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_render_template_delete`    | yes      | yes         | `DELETE /api/render/templates/:templateId` -- the PDFs survive, but nothing can rebuild them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_render_start`              | yes      | no          | `POST /api/documents/:documentId/render` -- queues a build; identical inputs hand back the PDF that already exists (`reused: true`) instead of building twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_render_status`             | no       | no          | `GET /api/render/jobs/:jobId` -- status, the produced file, the German reason for a failure, and whether the result is stale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_render_jobs`               | no       | no          | `GET /api/workspaces/:workspaceId/render/jobs` -- what has been built, optionally for one page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_render_log`                | no       | no          | `GET /api/render/jobs/:jobId/log` -- what Pandoc and LaTeX said. The only place a broken template explains itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `exo_render_artifact`           | no       | no          | `GET /api/render/jobs/:jobId/artifact` -- attachment id and download path. The PDF is an ordinary attachment, so `exo_attachment_read_text` reads back what the build produced                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exo_render_cancel`             | yes      | no          | `POST /api/render/jobs/:jobId/cancel` -- kills the container; a finished PDF is untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exo_entity_list`               | no       | no          | `GET /api/entities` -- the curated list of people, hosts, services, projects, credentials and organisations, with their aliases (issue #47)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_entity_profile`            | no       | no          | `GET /api/entities/:entityId` -- "what do I know about X" in one call: the current facts, the connected entities and the pages that talk about it, most recent first                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exo_entity_create`             | yes      | no          | `POST /api/entities` -- creates the row and queues a rescan of existing pages for its names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_entity_update`             | yes      | yes         | `PATCH /api/entities/:entityId` -- the alias list replaces the previous one wholesale, which is why it counts as destructive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exo_entity_link_page`          | yes      | no          | `POST /api/entities/:entityId/pages` -- a manual edge, for a page that is about the entity without naming it. Survives every re-extraction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exo_entity_unlink_page`        | yes      | yes         | `DELETE /api/entities/:entityId/pages/:documentId` -- an extracted edge comes back on the next save of that page, because the page really does say the name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `exo_entity_candidates`         | no       | no          | `GET /api/entities/candidates` -- names seen on enough separate pages to be worth proposing, with sample sentences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `exo_entity_candidate_confirm`  | yes      | no          | `POST /api/entities/candidates/:candidateId/confirm` -- turns a proposal into an entity and adopts the pages that produced it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `exo_entity_candidate_dismiss`  | yes      | yes         | `POST /api/entities/candidates/:candidateId/dismiss` -- permanently; the evidence is deleted with the decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The nine `exo_entity_*` tools are also a screen, at `/entitaeten`: the list with
its search and type filter, one entity's profile with its facts, connections and
pages, the two edits (type and aliases), a manual edge, and the candidate
proposals with **Anlegen** / **Verwerfen**. The proposals are the half that
needed it most -- the extraction pass fills that list on its own, so every one
of them used to wait for somebody to call a tool by hand (ADR-025).

The seven access tools exist because registration is closed (issue #3): "add a
person" is something a human can do in the admin area, so the catalogue has to
carry it too, or the MCP surface quietly stops matching the application. All but
`exo_invitation_create` with `via: 'workspace'` need an `admin`-scoped token,
because they sit under `/api/admin` and `requiredScopeForRequest` says so.

They stretch "destructive" to a second meaning: not overwriting what somebody
wrote, but taking away something somebody is holding. Withdrawing or re-sending an
invitation kills a link that may be about to be clicked; switching an account off
ends a session mid-sentence. A client that asks before destructive calls should ask
before these.

`exo_page_write` reaches a page that somebody has open at that moment: the API
hands the change to the collaboration server, which applies it to the live
document, so it appears in the editor immediately and the session's autosave
carries it instead of overwriting it ([ADR-016](adr/ADR-016-writes-reach-the-live-session.md)).
The response says so in `appliedToLiveSession`. `append` and `prepend` insert
only the new content there, so a person typing in that session keeps what they
wrote; `replace` replaces, as asked.

### Changing part of a page

`exo_page_write` is the whole page, and for a page of any size that is the wrong
tool for a small change: it costs the page in tokens twice, gives every block on
it a new identifier, and overwrites whatever somebody wrote in between. Three
tools do the same work through the addresses the page already has
([issue #111](https://github.com/HannaPanda/exocortex/issues/111),
[ADR-055](adr/ADR-055-a-narrow-write-addresses-blocks-on-both-sides.md)):

1. `exo_page_read` with `includeBlockIds: true`, or `exo_page_block_read`
   without a `blockId`. Both hand back the identifiers.
2. `exo_page_block_update` for one block, `exo_page_section_write` for
   everything under a heading, `exo_page_patch` for a piece of text.

All three refuse rather than guess: a block that is gone, a heading that occurs
twice, a text that occurs zero or several times. The response names the
candidates, so the next call is the unambiguous one. `expectedYjsUpdatedAt`,
taken from the read, turns "somebody changed this meanwhile" into a refusal
instead of an overwrite.

### Dividing a page that has grown too large

A page that no longer fits an agent's budget answers with its map rather than
its text ([issue #118](https://github.com/HannaPanda/exocortex/issues/118),
[ADR-056](adr/ADR-056-a-read-is-budgeted-and-answers-with-a-map.md)), and the
same addresses are what moves a part of it away:

1. `exo_page_block_read` without a `blockId` for the map, then with one for the
   section itself.
2. `exo_page_extract_section` with that identifier. The new page is created
   under the source page and named after the heading; `replacement` decides
   whether a link, an embedding or nothing stays behind.

One call rather than six, and no page content travels through the agent's
context on the way. The source page is snapshotted first, so the whole move
rolls back with `exo_page_restore_snapshot`.

### Putting a picture on a page

An image must come from this deployment. The Content Security Policy is
`img-src 'self' blob: data:`, so a picture on somebody else's host does not load
slowly or sometimes -- it never appears, and nothing in the page or the editor
says why ([issue #117](https://github.com/HannaPanda/exocortex/issues/117)).
Two steps:

1. Upload it. `exo_attachment_upload` with Base64 when you have the bytes,
   `exo_attachment_upload_url` when you only have an address -- that one fetches
   it here, through the same address check web research uses
   ([ADR-033](adr/ADR-033-web-research-is-two-rest-calls.md)).
2. Write `![Beschreibung](<embedUrl>)` with `exo_page_write`. `embedUrl` is
   `/api/attachments/<id>/download`, it is stable, and it is checked against the
   session on every request, so the picture stays as private as the page.

Not `downloadUrl`, which the same response also carries: that is a presigned
object-storage URL on a foreign origin that expires after five minutes. It
exists for a client that wants the bytes now, and a page that carries it is
broken twice over.

A write that points at a foreign host is still carried out -- an address that
cannot be loaded here is still an address -- but the response says so in
`warnings`.

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

## Resources and prompts

Tools are what the _model_ calls. The other two halves of the protocol belong
to the person in front of the client, and both are served since issue #48.

**Resources** are what a client lets someone attach to a conversation before
the model thinks at all. Until they existed, putting a page in front of a model
meant describing it in prose and hoping the model reached for `exo_page_read`
with the right argument.

| URI                                        | What it returns                                                      |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `exocortex://page/{documentId}`            | the page as Markdown, with its path and its direct children above it |
| `exocortex://workspace/{workspaceId}/tree` | the page hierarchy as indented lines, each with its id               |

`resources/list` names one tree per readable workspace plus the pages that
workspace was last edited in (the overview endpoint answers with six per
workspace, which is what caps the list). That listing is short on purpose;
`resources/templates/list` is what makes the other several hundred pages
addressable, with an id from `exo_search` or `exo_page_tree`.

**Prompts** are how an MCP server gives a client slash commands. `prompts/list`
answers with this deployment's AI rule pages — the same pages behind
`exo_rules_list` — named after their title (`schreibstil-fuer-johanna`), and
`prompts/get` returns the page as one `user` message. Rules with mode `off` are
not offered. The content was already reachable as a tool; what this adds is
that a _person_ can pick it, which is usually what a rule page wants.

Three things about how this is built:

- **The access check is the same one tools get.** Everything goes through the
  REST API with the caller's own credential, so `/api/workspaces` already
  answers with the readable workspaces and nothing else. A page somebody may
  not read is not refused, it is absent: a listing must not leak a title, and
  `resources/read` answers `-32002` for "you may not" and "does not exist"
  alike, so the method cannot be used to probe for ids.
- **Only the full surface serves them** (`context: true` in
  `createMcpRequestHandler`). The research and memory endpoints exist because a
  narrow catalogue is used better than a wide one; an attach menu of every
  recent page would hand back the breadth they were carved out to avoid. A
  surface without them still answers `resources/list` and `prompts/list` with
  an empty array, because clients probe those on connect regardless.
- **Both transports have them**, because both run the same dispatcher. That is
  the whole point of ADR-018.

## Subscriptions

`resources/subscribe` is the third part of issue #48 and the one that changes
the shape of the server: `notifications/resources/updated` travels from server
to client outside any response, so each transport had to open a channel for it
(ADR-035). `initialize` announces `subscribe: true` on a connection that has
one, and `subscribe: false` on one that does not — an unannounced capability is
an unreachable one, and an announced one that cannot deliver is worse.

| Transport       | Channel                                                  | What travels                                                                                                |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| stdio           | `GET /api/mcp/changes`, opened by the first subscription | resource URIs; the subprocess filters them against its own subscriptions and writes notifications to stdout |
| Streamable HTTP | `GET /api/mcp` with `Accept: text/event-stream`          | the JSON-RPC notifications themselves, for the URIs this `Mcp-Session-Id` subscribed to                     |

What one change touches is more than the page that was edited:
`resourceUrisForEvent` also names the **parent**, because a page resource
carries its direct children, and the **workspace tree** for anything that
changes the hierarchy. A deletion names the whole branch it took with it.

Four things are worth knowing before changing any of it:

- **Authorization is per message, not per connection.** For every event the
  accounts with an interested stream are asked against the database whether
  they may still read that workspace. Nothing is remembered from when the
  stream opened, which is why these streams need no re-authorization sweep the
  way the Socket.IO rooms do. The sweep that exists covers only a disabled
  account, which keeps its memberships.
- **A revocation closes the stream.** There is no way in the protocol to say
  "you may no longer watch that page", so the connection is replaced rather
  than patched and the subscriptions go with it (ADR-029).
- **Subscribing to a page that does not exist succeeds.** Refusing an unknown
  id while accepting a readable one would answer the question `resources/read`
  refuses to answer. The subscription simply never fires.
- **Heartbeats are load-bearing.** A comment line every 25 seconds, under
  nginx's 300-second idle timeout; the stdio feed reconnects after three
  missed ones. A stream held open by a proxy and carrying nothing is otherwise
  invisible.

A connection may hold at most 200 subscriptions and an account at most eight
streams across both endpoints; both are refusals rather than silent growth.

## Provenance: which session wrote what

Every connection announces a session id at `initialize`
(`POST /api/agent-sessions`), and `ExocortexApiClient` then stamps it on every
REST call as `x-exocortex-agent-session`, next to `x-exocortex-agent-client`
carrying the client's own `clientInfo` string. The API records one journal row
per mutation against that session, pointing at the snapshot taken before the
write (issue #49, ADR-022).

Where the id comes from depends on the transport. The stdio bin mints one per
process, because a subprocess is started for one client and dies with it. The
HTTP endpoint uses the client's `Mcp-Session-Id` and issues one when the client
brought none; it still keys nothing in memory, so two API processes go on
serving the same client interchangeably. A client that does not echo the header
back loses the grouping and keeps everything else.

Announcing is best-effort by design: if the call fails, the handshake proceeds
and the API creates the session row on the first write it journals. Provenance
is bookkeeping around the work and must never be able to stop it.

What this buys is in `/admin/agenten`: what one agent touched, and a button that
takes all of it back. `exo_agent_session_list` and `exo_agent_session_get` read
that record; the revert is deliberately not a tool (see `docs/admin.md`).

## Recipe: adding a tool

1. **Confirm the REST endpoint exists.** If it does not, add it to `apps/api`
   first (a different PR/wave); this catalogue never bypasses REST.
2. **Add the definition** to the right `packages/mcp-tools/src/tools/*.ts` file
   with `defineTool({...})`, a German `description`, and an `inputSchema` reused
   from `@exocortex/contracts` wherever it fits (`z.object({...}).extend(x.shape)`
   to add a path parameter to a request schema).
3. **Put the answer in `text`.** `data` is mirrored into `structuredContent`,
   which many clients never look at; `text` is what reaches the model. A result
   whose text is a summary of a payload only the structured half carries is a
   tool that returns nothing. `exo_page_tree` shipped like that and answered
   "3 Wurzelseiten" to every call, which is how ChatGPT ended up guessing a
   workspace instead of choosing one. Cap what could be unbounded
   (`truncateText`, a line limit) and say out loud that it was capped.
4. **Set `mutating` and, if `mutating: true`, `target`** — a function from the
   validated input to a stable string identifying the write destination
   (`document:<id>`, `workspace:<id>`). Every mutating tool must define one; the
   catalogue test enforces this.
5. **Set `untrustedOutput` when the result carries text from outside this
   deployment** — an extracted document, a fetched web page, a mail body
   (ADR-030). It marks the run in the built-in AI's loop: the result is fenced
   as data and mutating tools are refused for the rest of that run unless the
   workspace declared `ai.untrustedContentPolicy: 'allow'`. Per tool, not per
   call, like `destructive`. Leave it absent for anything a member of the
   workspace wrote.
6. **Export it** from the domain file's array (e.g. `PAGE_TOOLS`) and make sure
   `catalog.ts` re-exports that array into `EXOCORTEX_TOOLS`.
   **Set `surfaces: ['mcp', 'ai']`** unless there is a reason not to, and if
   there is, put it in `SURFACE_EXEMPT` in
   `scripts/check-capability-parity.mjs` (ADR-025). A tool on one agent surface
   with no entry there is a red gate, not a smaller tool.
7. **Extend `catalog.test.ts`** if the new tool needs a specific assertion
   beyond the blanket checks (unique `exo_`-prefixed name, ≥20-char German
   description, `z.toJSONSchema` succeeds, mutating ⇒ has a target). Add a
   focused test in `packages/mcp-tools/src/tools/*.test.ts` for anything with
   non-trivial formatting (truncation, table rendering, branching REST calls).
8. **No `apps/worker` change is needed.** The built-in AI tool loop reads
   `toolsFor('ai', ...)` from the same catalogue; the new tool appears there
   automatically once step 6 is done, gated by `ai.mutatingToolsEnabled` and
   `ai.untrustedContentPolicy` if it is mutating.
9. **Regenerate the matrix**: `node scripts/check-capability-parity.mjs --write`,
   and commit `docs/capability-matrix.md` with the rest. It is the audit of who
   can reach what, and the gate fails when it has fallen behind.

## Authentication

| Prefix   | Who mints it                                                          | Lifetime                                                                      | Used by                                                            |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `exo_`   | A user, via `POST /api/me/api-tokens`                                 | Until revoked or its optional `expiresAt`                                     | `apps/mcp` via `EXOCORTEX_API_TOKEN`, and `POST /api/mcp` directly |
| `exos_`  | The worker, per AI run; the API, per MCP request from an OAuth client | 300 seconds (AI) / 120 seconds (MCP), HMAC-signed with `SERVICE_TOKEN_SECRET` | The built-in AI's tool loop; the HTTP endpoint's loopback calls    |
| _(none)_ | The OAuth authorization server, per authorization                     | 1 hour, refreshable for 30 days                                               | ChatGPT and other remote connectors, against `POST /api/mcp` only  |

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
route in the API. Revoke a connector under **Einstellungen → Verbindungen**
(`/einstellungen/verbindungen`, section "Verbundene Anwendungen"): that deletes
the account's refresh grants and its consent and sets `disabled` on the
`oauth_client` row when nobody else still uses the registration. The `disabled`
check runs on every use, which is what makes it bite: an access token is a
signed JWT this server keeps no copy of, so there is no row to delete and
nothing else that could end one before its hour is up.

Neither the connections list nor the disconnect button is in the tool
catalogue, and that is a decision rather than an omission. Both live in the
`admin` scope precisely because they are credential management; a tool for them
would be a tool no correctly scoped agent can call, and an incorrectly scoped
one could use it to cut off the connectors watching it. The same reasoning
already keeps `/api/me/api-tokens` out of the catalogue.

`POST /api/mcp` does **not** accept a cookie session, only a bearer token. A
cookie travels with any request a page can provoke, so accepting one would put
every mutating tool one cross-site request away.

## The HTTP transport

`POST /api/mcp` carries one JSON-RPC message per request and answers with the
result as JSON; a POST is never answered with a stream, because nothing this
server does mid-call needs one. `GET` is the standalone SSE channel of the
specification and, since issue #48, opens one for a client that asks for
`text/event-stream`; anything else still gets 405. `DELETE` answers 204 so a
client that tidies up on shutdown gets a plain "fine".

`Mcp-Session-Id` names the connection in the write journal (ADR-022) and keys
its subscriptions in the memory of the process that answered. That is the one
piece of state this endpoint holds, and it is why a second API process would
need the set in Redis rather than in a `Map`.

Two endpoints, differing only in which tools they serve:

| URL | Tools | For |
| --- | --- | --- | --- |
| `https://exocortex.app/api/mcp` | the 53 `exo_` tools | a general-purpose agent |
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
PKCE. All of that is served by `@better-auth/mcp` under `/api/auth/oauth2/*`,
with the two discovery documents answered at the origin root, where clients
look for them:

- `/.well-known/oauth-protected-resource` — proxied straight through to the API,
  because the plugin answers it from a request hook that matches this very path
- `/.well-known/oauth-authorization-server` — rewritten by nginx onto
  `/api/auth/.well-known/oauth-authorization-server`, which is a real route

The protected-resource document names `https://exocortex.app/api/mcp` as the
resource, and every access token is audience-bound to it (RFC 8707). A token
minted here is therefore useless anywhere else, and a token minted elsewhere is
useless here.

In ChatGPT, add a connector with the URL `https://exocortex.app/api/mcp`
(or `.../api/mcp/research` for deep research) and pick OAuth. The browser lands
on `/anmelden` if signed out, then on `/verbinden`, which names the client and
what it is asking for. **Nothing is issued until that page is answered.**

A connector set up before better-auth 1.7 has to be removed and added again
rather than reconnected. ChatGPT keeps the endpoints it discovered when the
connector was created, and the 1.6 plugin's `/api/auth/mcp/authorize` is gone
(the reconnect button leads to a bare 404); its client registration is gone too,
because a client carried over from 1.6 is linked to no resource and every
authorization with it ends in `invalid_target`. Adding the connector again
rediscovers `/api/auth/oauth2/authorize` and registers a client that is linked
on the way in.

The consent screen is not a formality. Client registration is open, as the
specification requires, so without it any website could redirect a signed-in
person to the authorization endpoint with a client it registered seconds
earlier and receive a working token in silence. The provider does ask on its
own the first time, but it then remembers the answer and waves every later
authorization through, so the API adds `prompt=consent` to every authorization
request before the plugin sees it — in the query string and in the form body
alike (`forceConsentPrompt` in `apps/api/src/auth/auth.service.ts`). If a
consent screen ever appears that you did not set off, the answer is "Ablehnen".

### ChatGPT deep research

Deep research requires two tools named exactly `search` and `fetch`, answering
with JSON in the text content rather than prose. They are thin: `search` fans
out over the same `/search` endpoint `exo_search` uses, across every workspace
the account belongs to, merges by rank and returns `{id, title, url}`; `fetch`
returns the same Markdown `exo_page_read` returns, plus the title, a citation
URL and metadata. They live on their own surface (`surfaces: ['research']`) so
no other client is offered two unprefixed names, and the full catalogue is not
dumped on a connector that works badly with more than a handful of tools.

### The memory surface

`POST /api/mcp/memory` serves three tools instead of fifty-five: `recall`,
`remember` and `fetch`. It is what turns eXocortex from a reference work into a
memory for a chat client (issue #34, [ADR-019](adr/ADR-019-agent-memory-in-its-own-workspace.md)).

| Tool       | Mutating | REST call                                     | Answers with                                                                                     |
| ---------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `recall`   | no       | `GET /api/memory/recall`                      | three to five distilled hits with id, source and location, plus one ready-made German text block |
| `remember` | yes      | `POST /api/memory/remember`                   | where the note landed                                                                            |
| `fetch`    | no       | `GET /api/documents/:id` + `/export/markdown` | the full page (shared with the deep research surface)                                            |

`recall` is not `exo_search` with a smaller limit. It searches every workspace
the connected account may read, ranks the hits together, and weights the agents'
own notes above the curated pages, more so when the caller names a project. What
comes back is a handful of lines, never the raw index: a chat window carries
every answer for the rest of the conversation.

With `search.semanticEnabled` on, the search underneath both `recall` and
`exo_search` is full text and vector similarity fused
([ADR-020](adr/ADR-020-semantic-search-beside-full-text.md)). Neither tool's
shape changes; what changes is that a question phrased in words the note does
not contain can still find it, which is the ordinary case when an agent asks
"what did we do here last time".

`remember` writes into the caller's own memory workspace (`Workspace.isMemory`), under a page
per project, appending to today's note. It is the same endpoint the capture job
uses, so a note a person dictated and a note distilled from a session look the
same afterwards.

The three names carry no `exo_` prefix. That prefix exists so a coding agent
running several MCP servers side by side cannot confuse them; this surface is
configured on its own URL by somebody who wants exactly a memory.

**ChatGPT has no `SessionStart` hook**, so recalling has to be asked for. Paste
this into the custom instructions of the project or the account that has the
connector:

```text
Du hast über den eXocortex-Connector ein gemeinsames Gedächtnis.

- Bevor du auf eine Frage antwortest, die sich auf frühere Arbeit, getroffene
  Entscheidungen, Server, Zugänge oder Einrichtungen bezieht: rufe zuerst
  `recall` auf. Nimm den Suchbegriff aus der Frage.
- Interessiert dich ein Treffer genauer, lade ihn mit `fetch` und der id
  vollständig nach.
- Erfährst du etwas, das später noch gebraucht wird (eine Entscheidung, ein
  Pfad, ein Zugang, ein offener Punkt): lege es mit `remember` ab, kurz und in
  Stichpunkten. Nicht den Gesprächsverlauf ablegen.
- Findet `recall` nichts, sag das, statt zu raten.
```

Without those lines the connector is a lookup tool that is never looked up in.

## Memory over REST

The three tools call three ordinary endpoints, and so does everything else that
remembers (the Claude Code hooks in `tools/claude-code-plugin/hooks`, Hermes, a shell
script):

| Endpoint                             | Scope   | What it does                                                                                                                                                                                    |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/memory/recall`             | `read`  | Searches across the readable workspaces. Without `q` it answers with the newest notes for `project`. `maxChars` and `limit` are clamped by `memory.recallMaxChars` / `memory.recallMaxResults`. |
| `POST /api/memory/remember`          | `write` | Writes one distilled note under the project page. `appendToday` adds to today's note instead of starting a page.                                                                                |
| `POST /api/memory/capture`           | `write` | Hands a finished session over for distillation. Answers `{accepted, jobId, reason}` at once and never throws for something the caller cannot fix.                                               |
| `POST /api/memory/checkpoint`        | `write` | Secures the part of a running session that is about to be compacted away. Waits for the note, throws when it could not be written.                                                              |
| `GET /api/memory/facts`              | `read`  | The distilled facts of a project, best first. `status` picks between `current` (the default), `superseded` and `conflicted`.                                                                    |
| `POST /api/memory/facts`             | `write` | Applies one consolidation run. Not a tool: see below.                                                                                                                                           |
| `POST /api/memory/facts/:id/promote` | `write` | Copies a fact into a curated workspace somebody names.                                                                                                                                          |
| `GET /api/memory/messages`           | `read`  | The mailbox between agents. `box` picks `inbox` (the default) or `sent`, `status` between `unread` (the default) and `all`. Never marks anything read.                                          |
| `POST /api/memory/messages`          | `write` | Leaves a message for another account in the same memory area.                                                                                                                                   |
| `POST /api/memory/messages/read`     | `write` | Acknowledges messages, so they stop leading the next recall.                                                                                                                                    |

`recall` is a `GET` deliberately: `requiredScopeForRequest` derives the needed
scope from the method, so a `POST` would force every client that only ever looks
things up to hold a `write` token.

`capture` stores nothing itself. The transcript goes into a `memory-capture`
job, a model distils it, and only the summary is written; see
`docs/background-jobs.md`.

### The checkpoint before a compaction

`POST /api/memory/checkpoint` is `capture` with the opposite promise, and it
exists for one caller: an agent that is about to summarise the old part of its
own conversation and drop the wording (issue #92,
[ADR-046](adr/ADR-046-a-checkpoint-is-a-receipt-not-an-archive.md)). Hermes'
`compression.checkpoint_required: true` will only let that happen once a memory
provider has confirmed a durable write, so this call distils the evidence in the
request, writes the note, and answers afterwards. Everything `capture` reports
as a `reason` is an exception here: a soft refusal would reach the caller as a
successful checkpoint and become permission to forget.

The evidence arrives as a list of messages rather than one blob, because that is
what makes a second checkpoint cheap. Hermes does not send retries, it sends
longer prefixes; each message is hashed, the digests of this session's earlier
checkpoints are subtracted, and only the new turns are handed to a model. When
nothing is left the answer is the previous checkpoint with `deduplicated: true`,
which is a success. `sessionId` is required, since without it there is nothing
to recognise a second checkpoint by.

What is stored is a receipt: session, client, project, digests, two counts and
the note that came out. No message text, ever. `NICHTS` from the distiller is
recorded as a checkpoint with no document, and the caller may compact.

It is not a tool, for the same reason `capture` is not: it belongs to a client's
compaction lifecycle rather than to anybody's judgement, and the deliberate half
of it is `remember`. `integrations/hermes-memory-provider` is the Python package
that calls it.

### The facts above the notes

Since issue #46 ([ADR-021](adr/ADR-021-facts-above-notes.md)) the memory keeps a
second layer: statements that hold until a later note replaces them, distilled
nightly from the notes themselves. `recall` puts the current ones in front of
its hits, so a session that has just started is told what is true before it is
told what happened.

Two of the three endpoints are tools. `exo_memory_facts` reads them, including
the contradictions somebody has to resolve, and `exo_memory_fact_promote` moves
one into a curated workspace.

Both are also a screen, at `/gedaechtnis`: the list with its project and status
filters, and the **Übernehmen** button. ADR-021 calls promotion a human act,
and until that page existed it was the one human act with no human surface --
the person whose judgement it is had to ask an agent to press it.

The third, `POST /api/memory/facts`, deliberately is not, and it is the one
exemption in `scripts/check-mcp-catalog.mjs` worth understanding: it rewrites
what the memory believes in a single call, and it exists for the job that has
just read the notes it is judging. A model able to reach it directly could
rewrite its own past without any note saying so.

### The mailbox between agents

Since issue #51 ([ADR-047](adr/ADR-047-a-message-is-a-delivery-not-a-page.md))
an agent can leave a message for another account instead of hoping a person
repeats what it found. Three tools: `exo_agent_message_send`,
`exo_agent_messages` and `exo_agent_message_read`.

A message is a row rather than a page, which is the whole of that ADR. What
matters when reading the code here is the three properties it buys:

1. **Addressing is membership.** A message travels inside one memory area and
   both accounts must be members of it, so there is no permission question this
   feature had to answer for itself. The recipient is named by display name or
   email; `exo_agent_messages` lists the names that resolve.
2. **Reading never acknowledges.** `recall` puts unread mail in front of
   everything else and leaves `readAt` alone. The session-start hook in
   `tools/claude-code-plugin/hooks` marks the messages read _after_ it has
   written the context block, which is the moment delivery actually happened. A
   failed acknowledgement repeats a message; a premature one loses it.
3. **The text is fenced as data.** One renderer serves the recall, the listing
   and the tool, and it reserves the closing sentence's room before it writes a
   block, so an exhausted budget drops messages rather than the fence. The tools
   are deliberately _not_ `untrustedOutput`: a message comes from an
   authenticated member of this workspace, like the pages that member writes,
   and closing the write door for a whole run (ADR-030) would mean an agent that
   collects its post can no longer act on it.

`memory.recallMessageLimit` (default 3) and a quarter of the recall's character
budget are the hard ceiling the issue asks for. `memory.mailboxEnabled` switches
the whole thing off, and `prune-agent-messages` deletes what has expired, hourly
and without a retention setting of its own.

## Confirmation gate

**What the gate covers, since 2026-08-13:** the calls no snapshot brings back,
and nothing else. Eight tools declare `irreversible: true` and a test pins the
list by name: `exo_page_delete`, `exo_database_property_delete`,
`exo_database_option_delete`, `exo_comment_delete`, `exo_automation_delete`,
`exo_render_template_delete`, `exo_user_delete` and `exo_share_create`. An
ordinary write runs on the first call.

The last of those is the one entry that deletes nothing (issue #83, ADR-044).
It is here because "can I undo this" is the question the gate answers, and the
address of a public link is out the moment it is made: revoking it afterwards
stops the next reader, not the one who already has the page.

It used to cover every mutating tool, and the retirement is deliberate. The
gate stops no attacker: whoever holds the bearer token sends the call twice,
which costs a line of code. Its prompt is read by a model, never by a person,
and both clients this deployment serves already ask their human before a write.
Meanwhile the cost was real and recurring: a model that rewords its Markdown
between the two attempts never confirms and loops, and one such loop switched
from `append` to `replace` and overwrote a page (the pre-write snapshot got it
back). What actually guards a write is that snapshot, the trash, the token
scopes and the OAuth consent screen. See `ToolDefinition.irreversible`.

A deployment can have the old behaviour back: `mcp.writeConfirmationRequired`
(admin area, default off) widens the gate to every mutating tool over HTTP, and
`EXOCORTEX_REQUIRE_WRITE_CONFIRMATION=true` does the same for a given `apps/mcp`
subprocess. Neither can _narrow_ it below the eight irreversible calls.

Gated tools go through `WriteConfirmationGate`
(`packages/mcp-tools/src/confirm.ts`). The pending key is derived
**server-side** from `sha256(toolName + '\n' + target + '\n' + stableStringify(payload))`,
never from a client-supplied token. The first call to a mutating tool records
a pending entry and returns a German confirmation prompt as a normal (non-error)
tool result; the model reads it and, if it still wants to proceed, calls the
exact same tool with the exact same arguments again, which consumes the
pending entry and lets the call through. A changed payload or target starts a
fresh pending cycle; an unconfirmed entry expires after 5 minutes.

The prompt text spells that out at length on purpose. A model that reads
"call it again with the same parameters" as "call it again" will reword its
Markdown between attempts, hash differently every time, conclude the _content_
is being rejected, and start changing things that were never the problem — in
one observed run it switched from `append` to `replace` and overwrote a whole
page (the automatic pre-write snapshot got it back). So the message states that
nothing was written, that a single differing character counts as a new
operation, and that the prompt is not a complaint about the payload.

A tool may also say what its call would _do_, not just that it changes
something. `ToolDefinition.preview` is a read-only call the dispatcher makes
while the gate is pending, and its sentence goes in front of the prompt.
`exo_page_delete` is what it exists for: "delete page X" hides that X has eleven
pages, two attachments and four incoming references hanging off it, and for the
one operation nothing can undo, the announcement has to carry the size of what
is being announced. A preview that fails is left out rather than turned into an
error — the confirmation still has to be offered, or the caller could never
delete anything at all.

This exists because flauschibrain shipped a confirmation gate keyed on a
client-supplied token **twice** — a scheme that lets a model confirm an
operation it never actually announced, because the client (not the server)
controls what "the same operation" means. Keying on the tool name, the
declared write target and a hash of the payload closes that off structurally:
a client cannot fabricate a confirmation for an operation it did not first
request, and cannot swap the payload between the announcement and the
confirmation.

Over HTTP the gate lives in the API process and its key includes the user id,
so the announcement and the confirmation, two unrelated HTTP requests, pair up
per person and never across people. `mcp.writeConfirmationRequired` is read on
every `createHandler`, so widening or narrowing it takes effect on the next
request; it was written, shown in the admin area and documented on 2026-08-11
and read by nobody until 2026-08-13, during which the gate ran regardless of
the switch.

## Configuring a client

**The short way, for anyone who is not developing eXocortex:**
`/einstellungen/verbindungen` in the app. The "Einrichten" section prints the
finished line per client, with the deployment's own URL filled in, and with the
token already inside it when it was just created there. Nothing below has to be
retyped from this document.

Which rights to hand out:

| Client                             | Scope              | Why                                                                                                       |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| ChatGPT (OAuth)                    | _(none to choose)_ | It authenticates as the person; what limits it is the endpoint's tool list                                |
| Coding agents (Claude Code, Codex) | `write`            | They create and maintain pages, which is the point                                                        |
| Read-only lookups, dashboards      | `read`             | A token that cannot write cannot be made to write                                                         |
| Anything at all                    | **not** `admin`    | Nothing in the catalogue needs it, and it is the one scope that mints further tokens and cuts connections |

**ChatGPT does not call anything on its own.** It has no `SessionStart` hook, so
without an instruction it treats the connector as a reference work it consults
when asked. Paste this into the project's custom instructions to change that:

```text
Du hast einen eXocortex-Connector. Bevor du eine Frage beantwortest, die sich auf
frühere Arbeit, Entscheidungen, Setups oder Personen bezieht, such zuerst dort
danach und stütz die Antwort auf das, was du findest. Wenn ein Treffer relevant
aussieht, lad die Seite vollständig nach, statt nur den Ausschnitt zu verwenden.
Sag dazu, worauf du dich stützt.
```

**The two-line way, for Claude Code:** the plugin in
`tools/claude-code-plugin`. This repository doubles as its marketplace
(`.claude-plugin/marketplace.json` at the root), so installing it is:

```text
/plugin marketplace add HannaPanda/exocortex
/plugin install exocortex@exocortex
```

Claude Code then asks for the deployment's URL and a token, the second one
masked and kept in its credential store rather than in `settings.json`, and
substitutes both into the plugin's own `.mcp.json` (`${user_config.api_url}`,
`${user_config.api_token}`). The same two values reach the memory hooks as
`CLAUDE_PLUGIN_OPTION_API_URL` and `CLAUDE_PLUGIN_OPTION_API_TOKEN`, which is
the second of the four sources `hooks/config.mjs` reads. `/exocortex:einrichten`
then checks the configuration, the tool list and `recall`, and names whichever
of the four is wrong. The token never lives in the plugin: it is public and
identical for everyone.

**The long way, for a client that reads a config file:**
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

**Claude Code, without a config file** (one line, and the same line the
"Einrichten" section prints):

```bash
claude mcp add --transport http exocortex https://exocortex.app/api/mcp \
  --header "Authorization: Bearer exo_..."
```

`--scope user` at the end makes it available in every project instead of only
the current one. This is the better route for a machine that is not the server:
no path to a built `apps/mcp`, no `node` process, nothing to rebuild after a
deployment.

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

- **No attachment listing tool.** `apps/api/src/attachments/attachments.controller.ts`
  has no `GET /api/workspaces/:workspaceId/attachments` route (checked against
  the live controller before writing `exo_attachment_*`), so `exo_attachment_list`
  from the original plan was dropped rather than guessed at. Adding the list
  route is a follow-up for whoever next touches `apps/api/src/attachments`.
- **No download-URL tool.** `GET /api/attachments/:attachmentId/download` streams
  the file's bytes directly (it is not a JSON response with a presigned URL and
  metadata), which does not fit this catalogue's JSON-only tool-result model.
  The presigned URL is still reachable through the upload tools' response at
  upload time; fetching a fresh one for an already-uploaded attachment requires
  either a new `apps/api` route or downloading through the web app. Its
  _address_ is a different matter and needs no tool: it is
  `/api/attachments/<id>/download` for every attachment, forever.
- **No share-links API yet.** Nothing to wrap in a tool until those REST
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

- **Writing into an AI conversation is not in the catalogue**, by design
  rather than by omission: the catalogue is what an assistant may do _to a
  workspace_, and steering eXocortex's side panel from an MCP client would be
  steering a second, unrelated chat. Starting a conversation, posting into one,
  renaming or archiving one, and deleting one for good all stay out. This is
  also why the panel's slash commands (`/model`, `/think`, `/context`, …) have
  no tool counterparts.

  _Reading_ one is in, since issue #69. The old blanket exemption said "the
  caller of a tool is itself the assistant in a conversation, and it holds its
  own", which is true of writing and was never true of finding: an agent that
  cannot look up what was decided three weeks ago asks the person to repeat it.
  `exo_chat_list`, `exo_chat_search` and `exo_chat_read` are read-only and on
  both agent surfaces, and they see exactly what the caller's own account may
  see — the conversations it created, in workspaces it is a member of.

  The same line runs through the pinned sources (issue #75, ADR-043).
  `exo_chat_context` reads what a conversation carries; the three routes that
  pin, re-mode and unpin a source stay exempt, because deciding what a
  conversation carries is the person saying what leaves their workspace. A run
  that could pin a page would be widening its own context from inside itself,
  which is the argument ADR-030 makes about `ai.untrustedContentPolicy`.

  A run's _lifecycle_ is the deliberate exception (issue #6). "Is this run
  still alive, and can I stop it?" is a question about a job, not about
  somebody else's chat, and it is the whole point of that issue that the
  answer must be reachable from outside the browser panel too. Hence
  `exo_ai_run_get` and `exo_ai_run_cancel` — and hence both are declared
  `surfaces: ['mcp']` and are among the tools in the catalogue that the
  built-in AI does not get. A tool loop with a cancel button has, first of
  all, the button that cancels itself.

  `exo_ai_usage` (issue #10) is `mcp`-only for the neighbouring reason: what it
  reports on is the built-in AI itself, and a model able to read its own cost
  ledger mid-run will spend tokens reasoning about the tokens it is spending.

- **Two response shapes are defined locally, not in `@exocortex/contracts`.**
  See "Tool reference" above; `packages/contracts` was frozen for this wave.
