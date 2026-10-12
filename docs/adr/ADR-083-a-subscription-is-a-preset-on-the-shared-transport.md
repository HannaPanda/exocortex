# ADR-083: a subscription is a preset on the shared transport

- Status: accepted
- Date: 2026-10-12
- Relates to: ADR-009 (the provider contract), ADR-023 (whose key pays), ADR-032 and ADR-063 (OpenRouter's routing), issue #187

## Context

The built-in assistant was used sparingly because every token was billed
through OpenRouter. Several vendors sell a monthly plan for the same models
instead, and one of them, Cline Pass, was measured on 2026-10-12: DeepSeek
V4.1 Flash served by DeepSeek itself at about 145 tokens per second, cache
reads reported and billed at the cache price, and terms that allow scripts,
apps and automation explicitly. Its API is OpenAI's Chat Completions, close to
OpenRouter's: the same SSE stream, the same `usage.cost` and `cached_tokens`.
It differs in three small ways. An unstreamed answer comes wrapped in
`{ "data": …, "success": true }`, usage on a stream is requested through
`stream_options`, and OpenRouter's `provider` routing object means nothing
there.

Copying `OpenRouterProvider` into a `ClineProvider` would have been the quick
way and the wrong one: the next plan would have been the third copy of the SSE
parser, and a fix to tool-call reassembly would have landed in one of them.

## Decision

- **One Chat Completions transport, many dialects.** `ChatCompletionsProvider`
  in `packages/ai` holds the request shaping, the SSE parser, tool-call
  reassembly and usage mapping. A `ChatCompletionsDialect` declares what
  differs: its id, how usage is requested, the envelope of an unstreamed
  answer, whether OpenRouter's routing object exists, and extra headers.
  `OpenRouterProvider` is the transport with `OPENROUTER_DIALECT`, unchanged
  in behaviour and in its tests. A vendor whose protocol differs beyond these
  fields gets an adapter of its own, not another flag.
- **A subscription is a preset: data, checked by hand.**
  `packages/ai/src/provider-presets.ts` names the dialect, a fixed HTTPS
  address, and the OpenRouter slug each of its models corresponds to. The
  address is never read from a request or a setting, so a key can only travel
  to the host that issued it. Prices, quotas and terms are dated facts and live
  in the Brain page of #187, not in code.
- **The registry row chooses.** `AiModel.provider` already said which provider
  serves a model; a row naming a preset (`cline`) sends its runs through that
  preset, everything else through OpenRouter. The same holds for a job that
  takes its model from a setting: the boot provider is wrapped in
  `routeByModel`, which reads the row per request. The admin sync and the endpoint
  refresh only describe OpenRouter's rows, because a preset's slug is missing
  from OpenRouter's list by nature.
- **The key is the deployment's, and a missing key fails closed.** It comes
  from the environment (`CLINE_API_KEY`), like `OPENROUTER_API_KEY`, and never
  becomes a setting (ADR-023). A run on a preset whose key is empty fails; it
  never reaches for another account.
- **Falling back is a decision, not a reaction.** `withFallback` hands a turn
  to OpenRouter only when the preset refused it before the answer began (402,
  408, 429, 5xx, or no answer at all) and only when `ai.subscriptionFallback`
  is on, which it is not by default. A 400, 401, 403 or 404 is about the
  request or the key and stays a failure. Once a single fragment has arrived
  the turn belongs to the preset, because replaying it elsewhere could repeat
  what its first half set in motion.
- **A configured compaction model stays on OpenRouter.** Its slug is an
  OpenRouter slug; sent to a subscription it would be billed outside the plan.
- **Who answered and how fast is recorded per turn.** The turn event carries
  the eXocortex provider beside the gateway's `servedBy`, and the time to the
  first fragment, so a silent switch to a slow upstream inside the
  subscription, or a fallback, is visible in the run inspector.

## Consequences

- A second plan is a preset entry plus its OpenRouter equivalents, as long as
  it speaks Chat Completions; no new class, no new parser.
- The person decides per model where it runs, and per deployment whether a
  used-up plan may spend money elsewhere.
- Not built yet, and deliberately: personal keys bound to a user rather than
  the deployment, a distributed admission gate per credential, and a scheduler
  that waits for a plan's window to reopen. They belong to #187's later steps
  and to #147.
