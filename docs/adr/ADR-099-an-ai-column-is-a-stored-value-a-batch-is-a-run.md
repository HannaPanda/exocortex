# ADR-099: An AI column is a stored value, and a batch of cells is a run

- Status: accepted
- Date: 2026-11-27
- Relates to: ADR-011 (a row is a page), ADR-014 (the worker reaches the
  domain through REST), ADR-024 (automations), ADR-030 and ADR-096 (foreign
  content), ADR-041 (computed columns), ADR-090 and ADR-091 (who pays),
  ADR-098 (a cell's files), issue #237

## Context

A database column should be able to fill itself the way Notion's AI autofill
does: "summarise this letter", "the date of the document", "pick the tags that
fit", for one cell, a selection or the whole column, and on request
automatically for new or changed rows. Several things had to be decided
before that could be built: what such a value is, who pays for it and where it
shows up, what the model may read and what it may do with it, what happens to
a value somebody typed, and whether the existing automations are the engine.

## Decision

**An AI value is an ordinary stored value with a mark, not a formula.** ADR-041
keeps computed columns uncomputed on disk because they can be recomputed on
every read; a model's answer cannot, it costs money and it changes from one
call to the next. So the column keeps its type (Text, Number, Date, Select,
Person and the other writable ones), the value is written through the ordinary
row write with its checks, outbox event and realtime news, and
`document_property_value.aiRunId` names the batch that wrote it. Every other
write clears that id, so "this is the AI's value" can never outlive a person's
edit. The column's instruction is a sidecar row, `database_property_ai`
(preset, own words, target language, whether an answer may add an option,
which sources to read, `autoFill`), written by whoever may change the
database's columns.

**A batch is an `ai_run` of kind FILL.** The API decides which cells a batch
holds (the mode, the requester's right to edit each row, cells another batch
is filling, `ai.fillMaxRowsPerRun`) and writes the run, a
`database_ai_fill_run` with the instruction as it was at the start, and one
`database_ai_fill_cell` per row, in one transaction. The worker picks it up on
the `database-ai-fill` queue, pays with `providerFor` exactly as a chat run
does (the workspace's own key when it has one, an unreadable one stops the
batch, ADR-090/091), heartbeats like a run so the reaper covers a dead worker,
and the usage report counts it under its own kind. Cancelling is the ordinary
state change on the run, seen by the worker within one heartbeat.

**The model gets one cell, no tools, and the answer goes back to the API.** For
each cell the worker fetches the material from the API, assembled with the
requester's rights (the row's title, its other values, its page as Markdown,
its files with their text), asks for one JSON object and posts the answer
back. The API checks it against the column as it is at that moment
(`coerceAiFillAnswer`: a real date, an existing option, a member of the
workspace, a number) and writes it as the requester. Both routes answer only
the service token carrying this batch's signed run id. Files are fenced as
foreign content (ADR-030); since there are no tools, the most a planted
instruction can do is pick the value of that one cell, which is then checked
like any answer. The one thing an answer could do beyond its cell, adding a
new option to a Select column, is allowed only when the column says so, the
requester may change the columns and every file the model read is the
requester's own screened upload (ADR-096).

**Nothing a person wrote is overwritten unless the request says so.** A batch
carries a mode: `empty_only` (the default), `replace_ai` (also renew values the
AI wrote and nobody changed since) or `replace_all`. The mode is checked when
the batch is planned and again before each cell is asked and when its answer
arrives, so a value typed in the minutes a batch runs is kept.

**A cell's fate is a row, read back into the table.** Each cell records
queued, running, filled, empty, skipped, failed or cancelled with a code
(`AI_FILL_CELL_ERROR_CODES`), never a sentence. A row's response carries
`aiCells`: pending while a batch works on it, failed or empty while the latest
attempt ended so and nobody wrote the cell since, filled while the value still
carries the batch's id. Retrying is a new batch over the cells of a finished
one that did not end well.

**The column fills itself through the outbox, not through an automation
rule.** Automations (ADR-024) were the obvious engine and are the wrong one:
a rule is an owner's, needs an administrator's token, is switched off by
default for the whole deployment, is paid with the deployment's key, and an AI
rule is forbidden to write values at all. A column that fills itself is a
property of the column, so `autoFill` on the instruction is the switch, and the
outbox dispatcher that already wakes automations also queues, debounced per
row, an `auto` job for a row that was created (`on_create`) or whose text
changed (`on_change`). That job starts an ordinary batch through the API as
the account that last wrote the instruction, the way a rule runs as its owner,
in mode `replace_ai`, so it never overwrites a person's value. A value write
is deliberately not a trigger: a batch's own writes would wake it again.

## Consequences

- Formulas and rollups can read an AI column like any stored column, and an AI
  value can be filtered, sorted and edited by hand like any value.
- Every fill costs a model call per cell, is visible in the usage report and
  is bounded per batch; a column larger than the limit is filled in several
  batches, and the start answer says how many rows are left.
- A worker never writes a value itself; the API's checks are the only path,
  so a new column type that should be fillable needs a rule in
  `coerceAiFillAnswer` and nothing in the worker.
- The two worker routes are not tools (`check-mcp-catalog.mjs` names why);
  everything a person does with a fill is (`exo_database_property_ai_set`,
  `_remove`, `exo_database_ai_fill_start`, `exo_database_ai_fills`,
  `_status`, `_cancel`, `_retry`).
