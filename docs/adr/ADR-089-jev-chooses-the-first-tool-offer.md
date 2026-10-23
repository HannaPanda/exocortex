# ADR-089: Jev chooses a run's first tool offer, and the keywords catch it

- Status: accepted
- Date: 2026-10-23
- Amends: ADR-060 (a run is offered the tools its task needs)
- Relates to: ADR-013 and ADR-023 (settings and their scopes), ADR-025 (one
  capability, three clients), ADR-059 (a run never answers itself twice),
  ADR-073 (the run timeline), issue #108 (the decision contract), issue #206

## Context

ADR-060 chose the domains of a run from the person's own words with lowercase
substrings and no model call, and gave the run `exo_toolbox` as the way back.
Both halves were measured in issue #206:

- On a gold standard of 71 meanings in eleven languages (`evals/tool-routing/`),
  the keywords offered every domain a request needed in 13.8 % of the holdout
  cases. Jev 1.13, asked one yes/no question per domain through OpenRouter's
  Decisions API, did so in 98.1 %, at a p50 of about 250 ms and about
  $0.00005 per run. The local embedding challenger (multilingual-e5-small)
  reached 73.3 % and offered three unnecessary domains per request.
- In real agent runs the way back did not carry the weight ADR-060 put on it.
  The default model (DeepSeek V4.1 Flash) recovered a missed domain through
  the toolbox in none of fifteen cases and instead answered "there is no
  picture" or "nothing is pending" without looking. On 2026-10-23 a run that
  was offered no archive tool renamed a page fifteen times to its own title.

So the first offer decides the quality of the whole run, and the keyword
selection is not good enough to make it.

## Decision

**Jev chooses the domains a run starts with.** `routeToolDomains`
(`apps/worker/src/tool-routing.ts`) asks one question per routed domain in one
Decisions call and offers every domain at or above 0.5, the threshold chosen
on the dev split and confirmed once on the holdout. The words of the questions,
the product sentence and the state shape live in
`packages/mcp-tools/src/tool-routing.ts`, and the gold-standard script imports
them from there, so the question the worker asks is the question that was
measured.

**Three facts are added whoever chooses.** An open database view needs
`databases`, a proposing run needs `changesets`, a page carrying a picture or
a PDF needs `attachments`, and the domains the conversation's last three runs
called a tool of or opened with the toolbox are offered again
(`carriedToolDomains`). These are things the deployment knows without asking
anybody.

**The keywords stay, as the fallback.** No OpenRouter key, a call that takes
longer than 1.5 seconds, an error, an answer of the wrong shape or one without
a single probability: each ends in `selectToolDomains` exactly as before, and
the run starts anyway. Nothing about the routing can stop a run.

**It is a setting, on by default, with an emergency stop.**
`ai.semanticToolRouting` is a workspace-scoped key with a ceiling (ADR-023): a
workspace can switch itself off, and the deployment switching it off switches
every workspace off with it on the next run, without a deploy. Off is the
keyword selection, unchanged. Unlike the other settings that start talking to a
new recipient, this one defaults on, because the measurement is the reason it
exists. What leaves the deployment is the person's own last messages
(`taskTextFor`) and nothing else: no page, no attachment text, no system
prompt. When the chat model is a subscription preset, OpenRouter becomes a
recipient it was not before; the setting's help text names OpenRouter as the recipient.

**The switch is reachable by an agent, the other settings are not.**
`/api/admin/settings` stays out of the catalogue on purpose, because those keys
decide what agents may do. `GET` and `PATCH /api/admin/tool-routing` with the
tools `exo_tool_routing` and `exo_tool_routing_set` expose this one key, for a
deployment administrator, together with what the last 24 hours of runs were
routed by. That is defensible because of the next point.

**It is still not a permission.** Everything ADR-060 says about the offer holds:
`core`, `pages` and `exo_toolbox` are always offered, an unoffered tool stays
executable, and what may run is decided by the service token, the profile's
domain limit and `decideMutation`. Jev changes what a run is told about, never
what it may do.

**Every run records who chose.** A `tool_routing` event on the run timeline
names the decider (`jev`, `keywords`, `fallback`), the fallback's reason, the
domains, the carried ones, the page signals, the answering build and its cost.

Three smaller changes came with the measurement and belong to the same
decision: the prompt names every domain the toolbox could still open, with the
rule never to claim absence without looking (`toolOfferNote`); a write that
answers the same thing a third time carries a hint naming the toolbox (an
extension of ADR-059 that still never refuses a write); and the keywords learnt
"entfern", "wegräum", "weg damit", "aufräum" and "remove".

## Consequences

- Every run with tools enabled makes one extra call before its first turn,
  typically 250 ms and never more than 1.5 s. It is not counted against the
  run's budget; its cost is on the timeline event.
- The Jev model is pinned (`typesafe/jev-1.13`). A newer build is a new router
  and is adopted the way this one was: measured on the gold standard first.
- Rewording a domain question is a change to a measured router. The cached
  answers in `evals/tool-routing/results/jev-answers.json` are keyed by the
  question, so a reworded one shows up as uncached in the next measurement.
- The toolbox remains, and the measurement says to treat it as a net under a
  good first choice rather than as the way a run finds its tools.
