# ADR-074: an eval replays a task as an ordinary run, and never writes what people use

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-044 (a confinement travels with the credential), ADR-063
  (provider preferences are configuration), ADR-070 (a proposal changes
  nothing until a person applies it), ADR-071 (a profile only ever narrows),
  ADR-073 (a run's timeline is facts), issue #146, issues #136 and #42

## Context

Choosing between models and providers was a matter of impression. The
benchmark script of issue #122 measured five fixed tasks against four models,
but it lived outside the product: its tasks were code, its results a JSON
file, its fixtures pages under a hand-made test bed, and nothing stopped a
task from writing into a real page. Issue #136 (a subscription provider) and
every change to the system prompt, the context compiler, the tool
descriptions or the routing need the same thing: real tasks, kept, replayed
against variants, measured the same way every time, and compared, without a
replay ever touching what a person works with.

## Decision

**An eval case is a task with its checks, and every attempt freezes the case
it ran against.** `EvalCase` holds the prompt, where the task happens, the
agent profile, tool domains and limits, and two lists of checks from one
closed union (`evalAssertionSchema`): invariants, of which a broken one fails
the attempt whatever else happened, and criteria. Every edit moves
`revision`; an attempt keeps the whole definition in `caseSnapshot`, so a
measurement is never rewritten by a later edit. Cases are matched across
workspaces and runs by name, which is what lets a suite be exported as a file
(`exocortex.eval-suite/1`), versioned in a repository and imported.

**An attempt is an ordinary run of the built-in AI, tagged.** Starting an
eval run writes `EvalRun` and every `EvalAttempt` in one transaction and
answers at once; the attempts are then started one after another as
conversation turns whose run carries `evalAttemptId` from the statement that
creates it. Because it is an ordinary run, everything a run has an attempt
has: the inspector of ADR-073, the usage figures, the trace, the provider
routing of ADR-063. A variant is a model, a reasoning level and an optional
provider preference laid over the profile's routing keys, which is how a
model is compared with itself through two providers.

**How a replay stays harmless is explicit, per case, and enforced on the
server.** `replayMode` is one of three:

- `read_only`: the run's write mode is `read_only`, signed into its service
  token (ADR-070); the API refuses every write.
- `propose`: the run may propose. A proposal from an eval raises no attention
  item, is refused by `apply` with `eval_changeset_not_appliable` while the
  attempt runs, and is rejected (or, as a draft, deleted) when it ends; its
  shape stays in the attempt's artifacts.
- `fixture`: the case's own pages are copied into a sandbox for each attempt,
  under one container page per eval run. The run writes directly, but its
  service token carries the sandbox as a signed `pageRootId`, which the
  session guard turns into the page confinement of ADR-044, so every reader
  and writer that fails closed for a scoped token fails closed here. The
  sandbox is deleted once its final text is kept, and automations ignore any
  page in or under one.

Every eval run is also confined to its workspace. The worker reads the
attempt when the run starts, never the job payload, and lays its mode, its
profile (never the workspace default: a case taken from a plain chat turn is
replayed as one), its tool domains and its limits over everything else by
taking the stricter. A run that says it is an attempt and whose attempt is
gone, finished or unreadable is refused before it starts, because running it
unheld is the one outcome that must not happen.

**An attempt is settled from what its run left, and settling is idempotent.**
The run's terminal event, a sweep every half minute and the cancel route all
ask the same `settle`. It reads the run's columns and recorded steps
(ADR-073), its proposals and questions, and the sandbox, freezes the metrics,
decides the checks, and writes the outcome with a conditional update only
one caller can win; only the winner then takes back what the attempt was
allowed to leave: proposals, open questions (made obsolete), the sandbox, the
conversation in the chat list. The answer and the final page texts are kept
on the attempt, so the measurement survives the retention sweep of the run.

**Deciding is split, never blended.** Deterministic checks are decided by
eXocortex; a check it cannot decide is `manual` and answered in a review; an
undecided check (a manual one, a cost nobody reported) holds nothing up. The
outcome is `passed`, `failed`, `invariant_violated` or `error` (the attempt
could not be made at all, which says nothing about the model). A review adds
a verdict, a score and a note beside the outcome and never overwrites it;
only its answers to manual checks move the outcome, because those are checks
too. A judge model is left to a later DecisionProvider (#108), and the raw
figures are kept so its verdicts can be checked against them.

**The built-in AI may read evals and nothing else.** Writing a case,
importing a suite, starting, cancelling or deleting a run and reviewing an
attempt are MCP-only (`SURFACE_EXEMPT`) and refused for any request carrying a
run's signed id: a run that could write its own exam, fund runs of itself or
grade itself would not be measured by them.

## Consequences

- A comparison is only as fair as its variants are alike: the prompt, the
  case snapshot and the order are the same, and the variants alternate per
  repetition so none always warms a provider's cache, but provider load and
  a model's own variance are not controlled. Repetitions are the answer to
  the second; nothing here answers the first.
- A `read_only` or `propose` replay works on real pages as they are now, so
  its result can drift with the pages. A case that has to be reproducible
  over months belongs in the fixture mode.
- The fixture sandbox appears in the workspace's tree while its attempts run.
  It is one page per eval run, deleted with its last attempt; search and
  embeddings index it meanwhile like any page.
- A case taken from a run copies the run's page as it reads now, which after
  a run that changed it is the changed page. The dialog says so.
- A check that reads pages exists only for the fixture mode, and one that
  counts proposals only for the propose mode; `assertionsProblem` refuses the
  rest when the case is written, not when an attempt is decided.
