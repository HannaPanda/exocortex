# ADR-041: a computed column is SQL, not a second state

Date: 2026-09-19
Status: accepted
Issue: #76
Related: ADR-011 (a database is a `Document`), ADR-025 (three clients, one set
of capabilities), ADR-028 (a derived text is never a body)

## Context

`RELATION`, `ROLLUP` and `FORMULA` have been values of `DatabasePropertyType`
since ADR-011 without an implementation behind them: the enum reserved the
names so the round that built them would not need a destructive migration.
That round is this one, and it has to answer three questions that the existing
property types never raised.

**Where does a computed value live?** Every other property is stored: a row
has a `document_property_value` and the query engine reads it. A rollup and a
formula have no value of their own. The obvious shape -- compute on write and
store the result -- is the shape this repository has refused twice already: a
derived text is not a page body (ADR-028), Markdown is not the canonical state
(ADR-007). Storing a computed column would add a third thing that can be
stale, and the thing that makes it stale is a change to a _different_ row in a
_different_ database, which is the hardest kind of invalidation to get right.

**Where is it computed?** The acceptance criteria say filters and sorts have
to work on the new types. A value computed in TypeScript after the rows come
back can be displayed and nothing else: sorting by it would sort one page of
rows rather than the database, and filtering by it would page wrongly. So the
computation has to be inside the statement that reads the rows.

**How far may it reach?** A rollup reads a column of another database. That
database may have rollups of its own, pointing at a third. Left open, computing
one cell needs the schema of a chain of unknown length, and every link in it is
another workspace boundary to check.

## Decision

**A derived column is a SQL expression, compiled on every read.**
`packages/database/src/database-derived.ts` turns a ROLLUP or a FORMULA into a
`Prisma.Sql` scalar expression correlated to the row being read. The same
expression string is then used three times: in the `SELECT` list that returns
the value, in the `WHERE` clause when something filters on it, and in the
`ORDER BY` when something sorts by it. One definition, three jobs, and nothing
stored -- there is no cache to invalidate because there is no cache.

**A relation is a list of row ids in the column that already exists.**
`RELATION` writes `jsonValue`, the same array-of-ids shape `MULTI_SELECT`,
`PERSON` and `FILES` use, so `contains`, `is_empty` and the rest work on it
without a new operator and without a new column. Ids, never titles: the value
tells a reader which rows are linked and nothing about what they say.

**The formula language is our own, and total.** `packages/contracts/src/database-formula.ts`
is a tokenizer, a precedence-climbing parser and a type checker over four
types (number, text, boolean, date), a closed table of 22 functions and no
loops, no assignment and no property access. It is small enough to compile to
SQL and total enough that compiling cannot fail at runtime -- division is
wrapped in `NULLIF`, which is the only operator that could otherwise raise and
take the whole query down with it. It lives in `contracts` rather than in
`database` so the browser type-checks a formula while somebody writes it and
the API validates the identical tree before storing it.

**A rollup aggregates a plain column, never another derived one.** That single
rule is what bounds the third question: the schema a derived column may look
at is its own database plus the databases its relations point at, one hop, and
that is all `loadDatabaseScope` ever loads.

**A relation may only point inside its own workspace.** Checked when the
configuration is written, not when a row is read. Authorization here is per
workspace and per document, so a relation across that boundary would be a way
to learn which ids exist over there, and a `count` rollup over it would hand
out the numbers as well.

**A broken configuration is refused at write time.** Creating, changing,
renaming or deleting a property re-compiles every derived column of that
database first; a formula that does not type-check, a rollup whose relation
was deleted and two formulas defined in terms of each other are all refused
requests. Renaming is the exception that gets help rather than a refusal: the
formulas of the same database are rewritten through the tokenizer in the same
transaction, so `prop("Preis")` follows the column it names.

## Consequences

- Reading a page of rows with derived columns is one extra statement, whose
  cost is the correlated subqueries the expressions compile to. A rollup over
  a relation of 100 rows is a jsonb expansion and an indexed lookup per link,
  which is fine at the scale a person's database reaches and would not be at
  the scale of an analytics warehouse. That is the right trade for what this
  is.
- Filtering by a derived column cannot use an index, because there is no
  column to index. Accepted: the alternative is a stored value and the
  staleness that comes with it.
- A formula answers one of four types, decided by the checker. `apps/web`
  renders the value it receives without being told the type, so a date formula
  is recognised by the shape of its ISO string. The alternative -- shipping the
  result type on the property -- would be a second thing to keep in sync with
  the expression.
- The relation picker offers the first 100 rows of the linked database. A
  database larger than that needs a search field in the picker, which is a
  separate piece of work; until then the picker says it is showing only the
  beginning rather than pretending the list is complete.
- `database_property_reserved` is gone from the error catalogue. There is no
  reserved property type any more, and an error code for a state that cannot
  occur is a claim the documentation gate is right to reject.
