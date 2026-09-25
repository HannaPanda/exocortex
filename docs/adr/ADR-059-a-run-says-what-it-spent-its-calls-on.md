# ADR-059: a run says what it spent its calls on, and stops answering itself twice

- Status: accepted
- Date: 2026-09-21

## Context

ADR-056 to ADR-058 removed the reasons the run behind issue #118 went in
circles: a large page answers with a map, a write is bounded by growth, and a
semantic hit names the section it came out of. What they do not do is notice a
run going in circles anyway. That run made twenty calls in nine iterations,
ended on `ai_tool_limit_exceeded`, and left two records of itself: the error
code, and 1.36 million input tokens on the invoice.

The code is the one fact the reader already had. Nothing said that fourteen of
the twenty calls were the same search reworded, nothing said that the tool
results were where the tokens went, and the message the loop produced --
`Reached the tool iteration limit of 8` -- was not even stored: it travelled
on the socket to a panel that ignored it in favour of a canned sentence.

The issue asks for two things here, and is explicit that neither is the fix:
the fix was the map. These are what notices when the fix was not enough.

## Decision

**A repeated call is answered by the answer it would have given.** The guard
the issue describes as "same tool, same arguments, no write in between, same
page revision" is implemented as one comparison: the call runs, and its result
is hashed against what that same call answered earlier in this run. If the
hash matches, the model is handed a short hint naming the earlier call and the
three ways to something new, instead of the same text a second time.

This is the reason it is that way round rather than a rule about arguments. A
run may legitimately call the same tool with the same arguments repeatedly: a
build it started, a render it is waiting for, an activity feed. A rule about
arguments would need a list of which tools those are, would be wrong about the
next one somebody adds, and would break a run that is waiting for something.
Comparing answers cannot refuse anything that had something new to say: if the
build moved on, the answer moved with it. The cost is that the call is still
executed, which buys correctness with a round trip and saves the context
either way -- and context, not round trips, is what this issue is about.

Writes are never compared. A repeated write is how the confirmation gate
works, and two identical refusals or errors are two events rather than a loop,
so neither is booked as a repeat.

**A run keeps a tally, and the abort reads it out.** `ToolCallLedger` counts
per tool: calls, repeats, and the characters that tool put into the context.
`ai_tool_limit_exceeded` now says which tools the run spent itself on, how
much they returned, how many calls answered nothing new, and which way in
would have worked -- naming `exo_search`'s section anchor, `exo_page_block_read`
and the page map, because the failing run did not repeat itself out of
laziness but because it did not know there was another way in. It also says
that a higher limit is not the answer, since that is the first thing anybody
reaches for.

**The diagnosis is stored beside the code.** `AiRun.errorDetail`
is a new column, and `RunFailure` carries `detail` beside `message`: `message`
stays English because it is a log line (rule 8), `detail` is written for the
person and for the next agent. The panel shows it in place of the canned
sentence, `exo_ai_run_get` prints it as `Diagnose:`, and the `ai.run.failed`
event carries it so the panel does not have to wait for a poll. A diagnosis
that exists only in a socket frame is a diagnosis nobody reads twice.

**Amended 2026-09-25 (issue #98, ADR-062): the diagnosis is stored as facts.**
A finished German sentence cannot be read in another language, so the worker
now stores what it found rather than what it would say: `AiRun.errorDetailKey`
names a diagnosis (`toolLoop`, `runTimeout`) and `AiRun.errorDetailArgs`
holds its facts (the limit and the per-tool tally; the limit, level, streamed
characters and tool rounds of a timeout), validated by `aiRunDiagnosisSchema`
in `packages/contracts`. `RunFailure.diagnosis` replaces `RunFailure.detail`.
One renderer, `renderAiRunDiagnosis` in `packages/i18n`, turns them into
lines through the `diagnostics` namespace, and every reader calls it with its
own translator: the panel in the viewer's language, the API in the
requester's (`readerLocale`), so `exo_ai_run_get` answers in the caller's.
Numbers are ICU arguments, grouped the reader's way rather than by a
hand-written German separator. The worker still writes the German rendering
into `errorDetail`, and `ai.run.failed` carries it as `detail` beside
`detailKey` and `detailArgs`: a row older than the columns, and a reader that
does not know a key yet, show that text instead of nothing.

## Consequences

- A run cannot be handed the same answer twice, whatever it asks. What it gets
  instead is shorter than the answer was, so the guard always makes the
  context smaller and never larger.
- The duplicate guard is silent when it does nothing, which is almost always.
  It is visible in the tally as `repeats`, and in the worker log at info
  level with the characters it saved.
- A failed run is diagnosable after the fact, by the person and by an agent.
  Every other failure code gains the same column; today only the tool limit
  fills it, and the rest keep saying what they always said.
- The guard lives in the worker's tool runner, so it covers the built-in AI
  and not external MCP clients. That is where the loop happened, and an
  external client's context is its own to manage.
- The iteration limit itself is unchanged. Raising it was the tempting fix and
  is the wrong one: it buys a longer circle.

## Alternatives considered

**A flag on the tool catalogue saying which tools may be repeated.** Rejected:
it is a list that has to be right about every tool that exists and every tool
somebody adds, and being wrong about one breaks a run that is waiting for
something. Comparing answers needs no list.

**Refusing the repeat before executing it.** Cheaper by a round trip, and
wrong: without the answer there is no way to know the answer would have been
the same.

**Ending the run with a model-written summary instead of an error.** One more
turn costs a full prompt, and the run that needs this one is the run that is
already too expensive.
