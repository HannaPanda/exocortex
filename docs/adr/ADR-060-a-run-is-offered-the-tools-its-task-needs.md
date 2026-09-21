# ADR-060: a run is offered the tools its task needs, and can ask for the rest

- Status: accepted
- Date: 2026-09-21

## Context

`packages/mcp-tools` is one catalogue for two clients (ADR-014), and the two
pay for it very differently. An MCP client reads `tools/list` once at the
handshake and keeps it. The built-in loop puts the whole list into every single
request, because that is what a chat-completions call is: there is no handshake
and no memory, so the tools travel again with every turn.

Measured on the first Luna-versus-GLM benchmark, on 2026-09-21:

- 163 tools on the `ai` surface,
- 144,285 characters of serialized JSON schema,
- roughly 40,000 tokens, per turn,
- against a system prompt of 614 tokens for one workspace and 1,571 for the
  other, including its pinned page.

So a four-turn run spent about 160,000 input tokens describing tools, and under
7,000 on everything the run was actually about. Prompt caching hides part of
the money on a provider that offers it -- one of the six runs came back with a
91 percent cache rate and one with 0 percent, on the same task -- but it hides
none of the context budget, none of the latency, and nothing at all on a
provider that does not cache.

The other half of the observation is that this was never a fixed cost of doing
the work. The benchmark's three tasks were solved with four tools between them.

## Decision

**Every tool declares which part of the product it belongs to.** `domain` is a
required field on `ToolDefinition`, with twenty-one values in `TOOL_DOMAINS`
(`core`, `pages`, `databases`, `projects`, `render`, `shares`, and so on). It
is required rather than optional so the compiler is the coverage gate: a tool
written without a domain does not build, and there is no script to keep in step
with the catalogue.

**The built-in loop is offered a subset, chosen deterministically.** The
domains are selected from the user's own words -- lowercase substrings, no
model call, no round trip -- plus any the caller knows are needed from context,
which today means an open database view. `core` and `pages` are always
offered, because this product is a workspace of pages and a run that could not
read or write one would need the recovery path as its normal first step.

**There is a recovery path, and it is one call.** `exo_toolbox` is in `core`:
without an argument it names every domain that exists, and with one it opens
that domain, whose tools are in the next turn's request. The keyword table is a
guess and is allowed to be wrong; what it is not allowed to be is a dead end.

**None of this is a permission.** A tool that was not offered is still in the
catalogue, still reachable through `findTool`, and still executed if the model
names it anyway. What may run is decided where it was always decided: the
service token is minted for the run's own user, `decideMutation` applies the
untrusted-content policy, and `ai.mutatingToolsEnabled` still removes the
writes. Narrowing the offer is an efficiency, and the day somebody widens it
for convenience they must not be widening an authorization with it.

**What a run carried is recorded.** `ai_run` gains `toolsOffered`,
`toolSchemaChars`, `toolDomains` and `toolCalls`, written by both the success
and the failure path, because the expensive runs are the ones that fail. They
are columns rather than keys in the `usage` JSON for the reason the usage
columns are (issue #10): the question is asked across many runs.

## Consequences

Measured against the same catalogue, immediately after the change: a page task
is offered 22 tools and 29,032 characters instead of 164 and 148,119. A
database task gets 39 and 45,751; a LaTeX task 45 and 42,639. Roughly an 80
percent cut for the everyday case, repeated on every turn of every run.

A wrong guess costs one turn. That is the price the design accepts, and it is
why the always-on set is two domains rather than one: the everyday task must
never pay it.

The selection reads the last three user messages rather than only the newest.
A follow-up of three words ("und jetzt sortieren") carries none of the words
that opened the domain the question before it established, and losing the
domain there would make the recovery path the common case in exactly the
conversations that are going well.

The MCP surface is untouched: `toolsFor` narrows only when a caller passes
domains, and only the worker does. `exo_toolbox` is therefore on the `ai`
surface alone, with its reason in `SURFACE_EXEMPT`, since a client that already
holds the whole catalogue has nothing to open.

What this does not do is reduce the _content_ context. That is issue #110 and
a different problem: this is the static block that travelled regardless of what
the run was about.
