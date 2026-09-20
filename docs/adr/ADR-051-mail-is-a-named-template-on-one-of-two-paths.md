# ADR-051: a mail is a named template, and it takes one of exactly two paths

- Status: accepted
- Date: 2026-09-20

## Context

Until now this deployment sent three mails: verify your address, reset your
password, here is an invitation. All three were written, rendered and relayed
by `packages/auth/src/mailer.ts`, which was an honest description of the
system — every mail it sent was an authentication mail, and the transport sat
next to the only thing that used it.

Issue #102 is the point at which that stops being true. Four issues behind it
want to send mail that has nothing to do with authentication: a share changed
(#103), an automation fired (#104), here are the comments you missed (#106), a
rule failed for good (#107). With the transport where it was, each of them
would reach a relay by depending on the authentication library, and the worker
— which is where three of the four belong — would have needed a second
transport of its own.

Three questions had to be answered.

**Who sends, and when?** The tempting answer is "everything goes through a
queue", because a queue is the more robust of the two. It is wrong here for one
case: `POST /api/invitations` answers with `emailSent`, and a job that has not
run yet cannot say whether a mail went out. Better Auth's callbacks have the
same shape — the library awaits them and reports the failure to the caller.

**What travels in a job payload?** A rendered subject and body is the obvious
shape and the one every mail library suggests. The thing it does not survive is
the list of senders above: an automation's mail body is text a person wrote,
possibly with a model's help, and a digest's body is assembled from comments
other people wrote.

**What may be logged?** A mail is somebody's post. A log file is read by more
people, kept for longer, and shipped further than the mail itself.

## Decision

**Mail is a package.** `packages/mail` owns the SMTP connection, the TLS
decisions, the German wording and the failure classification, and it is the
only code in this repository that opens a connection to a relay. It may see
`@exocortex/contracts` and `@exocortex/logger` and nothing else — in
particular not `@exocortex/database`, because a package that could look up an
address would sooner or later be asked to decide who gets mail. What stays in
`@exocortex/auth` is `AuthMailer`: an interface of one method, which
`@exocortex/mail` satisfies structurally.

**Two paths, and which one a mail takes is decided by whether a request waits
on it.** Verification, password reset and the invitation go synchronously
through the API's `MAILER`, because their callers report the outcome.
Everything else is enqueued on the `mail` queue and sent by the worker, so a
relay having a bad five minutes delays a mail instead of failing the request
that caused it. Both processes build their transport from the same environment
variables with the same function: one relay, one place it is configured.

**A message is a named template and its values, never a subject and a body.**
`mailMessageSchema` is a closed discriminated union in the contracts, the
payload carries a variant of it, and `renderMail` — an exhaustive switch —
chooses the words afterwards. It follows that every field in a mail payload is
small and bounded: a title, a name, a link, a date. A page's text never travels
in one.

**Acceptance is not delivery.** `MailAcceptance` records what the relay said:
it has the message and owes us the next hop. Nothing in either process can know
whether an inbox ever shows it, so no log line, UI string or run log may call
it `zugestellt`.

**A refusal is not retried.** A 5xx reply, and a relay that accepted no
recipient, become a `PermanentMailError` in the transport and an
`UnrecoverableError` in the processor, so the job lands in the failed set where
somebody can see it. Everything else — a 4xx, a dropped socket, a name that
would not resolve — gets five attempts over about eight minutes, because what
a mail usually waits for is a relay that recovers in minutes, and retrying
faster than it does is how a deployment gets itself throttled.

**Only three things about a mail may be logged**: the template name, the
recipient's domain, and the relay's message id. `recipient` and `mail` are in
the logger's redaction list as a second line of defence, for the same reason
`prompt` and `messages` are there — nothing logs them today, and the entry is
what stops a later debugging line from quietly becoming a leak.

## Consequences

A new kind of mail is four steps and none of them involve a relay: a variant in
the union, a template, a branch in `renderMail`, an `enqueue`. The recipe is in
`docs/mail.md`.

Nothing in this repository can put a string of its own in front of a reader
under this deployment's `From:` address. That is a real restriction and it is
meant to be: when #104 lets an automation send mail, the rule that bounds what
that mail can say is already in place, and it is a type rather than a review
habit.

Deduplication is the producer's `jobId` rather than a field in the payload,
which means it holds for as long as BullMQ keeps the completed job — an hour.
That is the right window for the case it exists for (an outbox row redelivered
seconds later) and the wrong one for anything longer, so a sender that needs a
longer guarantee will have to record what it sent, as #106's digest already
plans to.

The `mail` queue ships with no producer. It is the foundation #103 to #107
build on, it is tested, and until one of them lands the only mails this
deployment sends are the three it sent before — by the synchronous path, with
their wording unchanged.
