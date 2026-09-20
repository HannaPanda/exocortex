# ADR-053: a digest is a queue of pointers, and the mail is built at send time

- Status: accepted
- Date: 2026-09-20

## Context

[ADR-052](ADR-052-an-occasion-is-not-a-transport.md) split the occasion from
the transport and put `DAILY_DIGEST` in the mode union without anything behind
it. Issue #106 is the other half: comments should be able to reach somebody by
mail, and a mail per reply is how a useful notification becomes a filter rule.

The recipient question was already answered, once, in
`comment-notifications.ts`: the page's author plus whoever is in the thread,
never the person who just wrote, and only those who may still read the page --
membership or an unexpired `USER` grant, with `SUBTREE` resolved against the
hierarchy (ADR-044). The issue is explicit that this must not be rebuilt for
mail and then maintained in two divergent copies.

What was genuinely undecided was where a digest's contents come from between
the comment and the mail. Three answers were on the table.

**Reconstruct from the push jobs.** Rejected before it was considered: a queue
is not a record, the jobs are gone after their retention window, and a device
with push switched off would make the mail disappear with it.

**A checkpoint per person.** Store "last told at", and at send time read every
comment written since. Cheap in schema and expensive in truth: deciding who
each of those comments concerns means running the recipient logic again, a day
later, over a thread that has moved -- a second implementation of the one thing
that must not have two.

**A row per owed comment.** What this ADR chooses.

## Decision

**A pointer is written where the recipient is already being decided.** When
the outbox passes `comment.created`, the same recipient set that gets a push
gets a `CommentDigestEntry`: `(userId, commentId, documentId, workspaceId,
createdAt, sentAt)`, unique on `(userId, commentId)`. One recipient
calculation, one moment, both channels.

**The row carries no text.** It is a pointer, and the mail is built from the
comment rows when it is sent. That is what makes the three promises cheap: a
comment deleted in between took its pointer with it (the foreign key
cascades), a comment edited in between reads as it does now, and a page whose
grant was withdrawn in between is dropped by a re-check rather than by
remembering to.

**Access is re-checked at send time, per page.** `filterUsersWithPageAccess`
is the same function the push side calls, asked again. A thread of twenty
replies is one page and one question.

**`sentAt` is the whole of the bookkeeping.** An entry that has one is history
and cannot appear in a second mail; an entry without one is owed, however many
times a send failed. There is no checkpoint beside it, because a checkpoint and
a set of rows are two things that can disagree about the same day.

**The order is enqueue, then mark.** The two are in different systems and
cannot be made atomic, so the choice is which way to fail. Marking first would
lose a digest when the enqueue throws; enqueueing first can duplicate, and that
duplicate is removed by deriving the job id from the person and the oldest owed
entry -- stable across a retry, and moved on as soon as a mail has gone out.
Losing somebody's mail is the worse failure, so it is the one that cannot
happen.

**`IMMEDIATE` and `DAILY_DIGEST` are the same code path.** They differ in one
predicate: whether the oldest owed entry is older than a short debounce window,
or older than the last time the clock struck the digest hour. Both then collect,
re-check, group and send the same way, with the same template. A separate
"one new comment" mail would be these words with the plural removed, kept in
step by hand for ever -- and `IMMEDIATE` would lose the bundling that a thread
being typed into actually wants.

**The digest hour is configured and the zone is explicit.** There is no
per-account time zone in this deployment, and the server runs in UTC, so
guessing would post everybody their morning mail at two in the morning with
nothing reporting it as a fault. `notifications.digestHour` and
`notifications.digestTimeZone` are deployment-wide (ADR-023): one mail per
person spans every workspace they are in, so a workspace-level answer would be
several answers to a question with one mail behind it. When a per-account zone
exists, this becomes its fallback rather than its replacement.

**Comment mail is `OFF` by default.** Unlike the share mail beside it, which
is on because a share nobody hears about is a share nobody uses. Push already
reaches whoever registered a device, so silence here loses nothing, and a
deployment that gains a feature must not thereby start writing to people who
never asked it to.

## Consequences

The mail says less than the thread does, on purpose: a preview of about 140
characters per comment, at most five comments per page and ten pages per mail,
with the remainder stated as a count rather than dropped. A mail that repeats
the discussion is a mail people answer by replying to it, and nothing here
reads replies.

An entry that can never be delivered is still answered. When every page in
somebody's pending digest has become unreadable, the entries are marked sent
and no mail goes out -- marked rather than deleted, because they have been
dealt with, and an entry left owed would be reconsidered every minute for ever.
A switched-off account is the one case where they are deleted instead: it may
not be written to at all (issue #3), and there is nothing to answer.

The sweep runs every minute, which is the finest a schedule can be, because
`IMMEDIATE` has to mean it. It costs one grouped query per run on a deployment
where nobody has switched the mail on, which is every deployment until somebody
does.

The zone arithmetic three features now share (`lastLocalHourSlot` and the
conversions under it) moved into `packages/contracts/src/zoned-time.ts`. It
existed twice before -- in `automation-schedule.ts` and in the worker's
reminder times -- and a third copy is how the one that got the spring-forward
hour wrong would have gone unnoticed until March.
