# Agent evals

Issue #146, [ADR-074](adr/ADR-074-an-eval-replay-never-writes-what-people-use.md).
An eval case is a task the built-in AI has to do, kept with checks of what has
to be true afterwards. An eval run replays cases against variants (model,
reasoning level, provider preference), each a number of times; every replay is
an attempt, which is one ordinary run of the built-in AI.

## Where things are

| Piece         | Location                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Tables        | `eval_case`, `eval_run`, `eval_attempt`, `ai_run.evalAttemptId` (`schema.prisma`)                                  |
| Wire contract | `packages/contracts/src/evals.ts`: the check union, the fixture, the variant, metrics, results, the suite file     |
| REST          | `apps/api/src/evals/` (controller, case and run services, sandbox, settlement, pure checks and comparison, mapper) |
| Worker        | `apps/worker/src/processors/ai-run/eval-hold.ts`; the sandbox filter in `maintenance-tasks/automations.ts`         |
| Token claim   | `pageRootId` in `packages/auth/src/service-token.ts`, read by `SessionGuard` into a page confinement               |
| Tools         | `packages/mcp-tools/src/tools/evals.ts`, domain `evals`                                                            |
| Browser       | `apps/web/src/components/evals/`, routes `/arbeitsbereich/:id/evals`, `/evals/:runId`, `/evals/faelle/:caseId`     |
| Words         | `packages/i18n/src/messages/de/evals.json`, feature entry `evals`                                                  |
| Regression    | `evals/regression.json` in this repository, imported with `exo_eval_suite_import` or `POST .../eval-suites/import` |

## Routes

| Route                                         | What                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/eval-cases`          | the cases, `suite` filters; answers with every suite name                     |
| `POST /api/workspaces/:id/eval-cases`         | a case; MEMBER, never a run of the built-in AI                                |
| `GET /api/eval-cases/:id`                     | the case with its latest 30 attempts across runs                              |
| `PATCH /api/eval-cases/:id`                   | partial; the rules are checked against the merged case; moves `revision`      |
| `DELETE /api/eval-cases/:id`                  | the attempts stay with their snapshot                                         |
| `POST /api/ai/runs/:runId/eval-case`          | a case from a real run: its prompt, page and profile; the mode is chosen      |
| `GET /api/workspaces/:id/eval-suites/:suite`  | the suite as a file without ids                                               |
| `POST /api/workspaces/:id/eval-suites/import` | matched by name: created, updated, unchanged, skipped with a reason           |
| `GET /api/workspaces/:id/eval-runs`           | the latest 50 runs with counts and cost                                       |
| `POST /api/workspaces/:id/eval-runs`          | `caseIds` or `suite`, `variants`, `repetitions`, `label`; at most 60 attempts |
| `GET /api/eval-runs/:id`                      | the run, every attempt with its answer, and its comparison                    |
| `POST /api/eval-runs/:id/cancel`              | settles the open attempts as cancelled and stops their runs                   |
| `DELETE /api/eval-runs/:id`                   | cancels first, then deletes with every attempt                                |
| `GET /api/eval-comparison?runIds=a,b`         | up to five runs side by side, cases matched by name                           |
| `GET /api/eval-attempts/:id`                  | one attempt with answer and artifacts                                         |
| `PATCH /api/eval-attempts/:id/review`         | `verdict`, `score`, `note`, `manual` answers; only a finished attempt         |

## Rules worth knowing before changing anything

- **The run is created already tagged.** `ConversationsService.postMessage`
  takes an internal `evalAttemptId` and writes it in the statement that
  creates the run, and the attempt is `RUNNING` before that. The worker
  refuses a tagged run whose attempt is gone, not running or unparseable
  (`eval_attempt_invalid`). A second path that starts an attempt's run has
  to keep both.
- **What holds the run is read in the worker.** `resolveEvalHold` turns the
  frozen case into a write mode (`evalReplayWriteMode`), a profile (never the
  workspace default), tool domains, limits, provider keys and, for a
  fixture, the sandbox as `pageRootId`. Each is combined by taking the
  stricter; nothing in a job payload or a request can loosen it.
- **A fixture is real pages in a confined branch.** `EvalSandboxService`
  builds them with the ordinary document services as the person who started
  the run, under one container page per eval run, records the sandbox ids
  _before_ writing into them (the automation filter reads them), and keeps
  each page's text right after the copy as its baseline. A new place that
  reacts to page events and could act outward (a webhook, a mail) has to
  skip a page under an `eval_attempt.sandboxDocumentId` or an
  `eval_run.sandboxDocumentId` the way `fireMatchingAutomations` does.
- **Settling is the one place an attempt ends.** `EvalSettlementService`
  freezes metrics, decides the checks and writes the outcome with a
  conditional update; only the caller that wins cleans up. Its clean-up
  steps run independently and log a failure rather than throwing, because a
  sandbox left behind is visible and deletable, a lost measurement is not.
- **An eval proposal never reaches a page.** `ChangesetsService.submit` raises
  nothing for one and `apply` refuses it (`eval_changeset_not_appliable`); the
  settlement rejects what was handed in and deletes drafts.
- **The outcome is the checks', the verdict the person's.** A review never
  overwrites `outcome`; only its answers to `manual` checks recompute it.

## Adding a kind of check

A member of `evalAssertionSchema` (and, if it only means something in one
mode, a line in `EVAL_ASSERTION_MODES`), an entry in `DECIDERS` in
`apps/api/src/evals/eval-assertions.ts` with a test, the facts it needs in
`EvalFacts` if they are new, its kind and its summary sentence in
`evals.labels` of the German catalogue, its fields in
`apps/web/src/components/evals/eval-case-checks.tsx` and `eval-case-draft.ts`,
and a word in `CASE_HELP` in the tool file. Then `pnpm i18n:translate --all`.

## The regression set

`evals/regression.json` is a suite in the export format, written by hand and
kept in this repository so a change to the system prompt, the context
compiler, a tool description, the routing or the default model can be
checked against the same tasks. Every case in it uses the fixture mode, so it
needs no page of any particular workspace and writes nothing anybody uses.
Import it into a test workspace (`exo_eval_suite_import`, or the browser's
API), start a run of the suite, and compare it with the last one.
