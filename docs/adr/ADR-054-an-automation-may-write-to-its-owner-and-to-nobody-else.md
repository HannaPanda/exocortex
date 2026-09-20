# ADR-054: an automation may write to its owner, and to nobody else

- Status: accepted
- Date: 2026-09-20

## Context

Issue #104 asks for mail as a third automation action. The pull is obvious
once the clock exists (ADR-038): a daily agenda at 07:00, a weekly review on
Sunday evening, "send me this page on Friday" -- all of them are a `SCHEDULE`
trigger plus a sender, and none of them needs a line of new scheduler code.

What needed deciding was not the transport. It was who an automation is
allowed to write to, and what it is allowed to put in the letter.

Both questions are sharper here than anywhere else in this deployment, because
of who writes the rules. A rule is written by a person in a dialog or by an
agent through `exo_automation_create`, and it keeps acting long after the
session that created it is gone. Two existing decisions bear on it directly:

- **ADR-024** starts the webhook action from a refusal. The host allowlist is
  empty by default, so a rule that can telephone anywhere is something a
  deployment has to say yes to, once, deliberately, because that is the
  shortest way to carry a workspace's contents out of it.
- **ADR-051** made a mail a named template with a handful of short fields,
  precisely so that the things which would enqueue mail next -- this feature
  among them -- could not choose a subject and a body. A queue that accepts
  prose is a relay for whatever can reach it.

A recipient field on an automation rule would have walked straight through
both. It is an allowlist-free way to send this deployment's content to an
arbitrary address, with our `From:` on it, written by whoever could write a
rule.

## Decision

**A mail automation has no recipient.** The action is `EMAIL_SELF`, and the
name is the decision rather than a description: there is no column on
`automation_rule` naming an address, no field in the create request, no
parameter on the tool. The address is read from the account on `createdById`
at the moment the mail is queued, and only while that account exists, is
switched on, and has a **confirmed** address -- an unconfirmed one is a string
somebody typed, not an account's post box.

Three consequences follow, and all three are the point:

- The deployment cannot become a spam relay, with or without an allowlist to
  maintain.
- An agent that may write rules gains no way out of this deployment that it did
  not already have. It can mail the rule's owner their own page; it cannot mail
  anybody else anything.
- The question "may this content leave" collapses into "may this account read
  it", which is already answered. The page is fetched through the API **as the
  owner**, so a rule cannot mail out a page its owner may not read.

**The mail carries the page, and is the one template that does.** Every other
variant of `mailMessageSchema` is _about_ something and keeps the thing behind
a link. `AUTOMATION_PAGE` is the thing: somebody asked for their agenda at
seven, and answering that with a link would be a notification they did not ask
for. That is defensible here and nowhere else, and for exactly one reason --
the recipient cannot be anybody but the person who asked. If a later version
lets a rule name an address, this variant goes back to being a link.

The subject is the same bargain: free text on a rule, in a mail header, read
only by whoever typed it. It is bounded like a title, and the rendered subject
is still prefixed `eXocortex:` so it cannot be mistaken for a letter somebody
else wrote.

**It is cut at 10 000 characters**, on a line boundary, and the mail says that
it was cut, with the link underneath. Much lower than the 20 000 an AI rule
reads, because a mail is a copy that leaves and cannot be corrected.

**The action queues rather than sends.** The run records that the mail was
handed to the `mail` queue -- `queued`, never `sent` and never `zugestellt`
(ADR-051) -- and the relay conversation happens in the mail job under the mail
queue's retry policy. Sending inline would have let a relay having a bad five
minutes fail five runs in a row and switch a perfectly good daily rule off
(`automations.maxConsecutiveFailures`). The mail's job id is derived from the
run id, so an automation job retried after it had already enqueued cannot post
a second copy of the same morning.

**A refusal is a failed run, not a skipped one.** An owner with no confirmed
address, or a switched-off account, means the rule is broken: it should end up
visibly disabled with the reason on it rather than quietly doing nothing every
morning at seven.

**There is no notification preference for it.** ADR-052's catalogue is about
occasions somebody is _told_ about, where the default has to be chosen for
people who never decided. A rule is the decision: somebody wrote it, named the
page and set the time, and a global switch that silently stopped it would make
a rule that says it is enabled into one that does nothing. Switching it off is
`enabled: false` on the rule, where it was switched on.

## Consequences

- `AutomationAction` gains `EMAIL_SELF` and `automation_rule` gains exactly one
  column, `mailSubject`. No recipient, no template selection, no attachment
  options; each of those is a decision that can be taken later, and none of them
  can be taken back.
- Daily and weekly mail needs no scheduler code. `SCHEDULE` plus `EMAIL_SELF`
  is the whole feature, which is what ADR-038's column-not-a-repeatable-job
  bought.
- A deployment with no relay is not a failure state, as everywhere else: the
  run succeeds, the mail job succeeds, and `createMailerFromEnv` logs what it
  would have sent.
- Extending this to other recipients is a deliberate later decision and a
  bigger one than it looks. Another confirmed account in the same deployment is
  arguable; an arbitrary external address needs an allowlist, and at that point
  it is the webhook question again with a worse protocol.
