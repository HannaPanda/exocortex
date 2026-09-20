# ADR-052: an occasion is not a transport, and a preference is stored where the question lives

- Status: accepted
- Date: 2026-09-20

## Context

Two features arrived a day apart and neither knew about the other.

[ADR-048](ADR-048-a-subscription-is-a-device.md) gave this deployment push
notifications and, with them, a `PushNotificationKind` column on each device:
`CALENDAR_REMINDER`, `COMMENT`, `AGENT`. The argument for putting it on the
device rather than on the person was good and still is -- a phone in a pocket
and a desktop at work want different things, and one per-person switch cannot
say so.

[ADR-051](ADR-051-mail-is-a-named-template-on-one-of-two-paths.md) gave it a
mail package, and issue #103 gave it the first mails nobody asked a request
for: a share notification, sent from the outbox, to somebody who may not even
be a member here. Those went out unconditionally. There was no switch, because
there was nowhere to put one.

Issue #105 is what happens next, and it is a modelling question rather than a
feature. Issues #106 and #107 both want to send mail about things that already
notify somebody by push -- a comment, a failed run -- and both would otherwise
invent their own place to store "does this person want that". Three such places
is three policies, and the one that forgot a case is the one that mails
somebody who switched it off.

Four questions had to be answered.

**Is a push kind the same thing as a mail?** `COMMENT` the push kind and a
hypothetical comment digest are obviously about the same event, but the two
vocabularies had nothing in common: one was three values on a device, the other
six template names in a discriminated union.

**Where does a preference live?** ADR-048 says the device, and says so for a
reason that has not stopped being true. A mail address is not a device.

**Is a switch a boolean?** For push it is. For a comment mail it is not: the
useful answer is often "yes, but once a day".

**What decides, and when?** The choice is between asking near the sender --
every processor checking for itself -- and asking in one place.

## Decision

**The occasion is `NotificationKind` and the transport is
`NotificationChannel`, and they are separate.** The kinds are `SHARE`,
`COMMENT`, `CALENDAR` and `AGENT`: things that happen while nobody is looking,
named after what happened rather than after how it travels.
`PushNotificationKind` is gone as a vocabulary; the device column now holds
`NotificationKind` values, and the migration carries `CALENDAR_REMINDER` over
as `CALENDAR` rather than resetting anybody's device.

`packages/contracts/src/notifications.ts` holds `NOTIFICATION_CATALOG`, and it
is deliberately not a cross product. A pair appears there only when something
actually delivers it, because a switch that reaches no sender is a promise this
deployment does not keep. Today that is four entries: `SHARE` over `EMAIL`, and
the three push kinds over `PUSH`. Issue #106 adds `COMMENT/EMAIL` in the same
commit series as the digest that sends it, and #107 its failure kinds.

**A preference is stored where the question lives, and the catalogue says
where.** Each pair carries `storedOn`. `device` means ADR-048 is unchanged and
the answer is the `kinds` column on the browser; `account` means a row in
`notification_preference`. There is no per-person push switch, so there is
nothing to reconcile with the rows that would disagree with it -- the objection
ADR-048 raised against adding one later is answered by never adding one. A
check constraint refuses a `PUSH` row outright, so the split cannot be crossed
by a bug, and dropping that constraint is what a second account-wide channel
has to cost.

**An absent row means the catalogue's default**, exactly as an absent
`workspace_setting` means inherit ([ADR-023](ADR-023-settings-have-a-scope.md)).
Setting a preference back to its default deletes the row rather than storing
the same value, so a default that changes later moves everybody who never
decided rather than only the people who never touched the switch.

**A mode is `OFF`, `IMMEDIATE` or `DAILY_DIGEST`**, and the third exists in the
union before anything produces one. The routing layer has to be able to answer
"queue now, or collect for later" before there is anything to collect;
introducing the mode afterwards would mean migrating rows that already say
`IMMEDIATE` and guessing which of them meant it. No catalogue entry offers it,
a unit test says so out loud, and the share dispatcher tests `=== 'IMMEDIATE'`
rather than `!== 'OFF'` so a collecting mode can never fall through to sending
at once.

**One resolver, in `packages/database`, asked before anything is enqueued.**
`resolveNotificationMode` and `filterImmediateRecipients` live beside the
schema rather than in a service because both halves of the deployment have to
ask them: the API while answering the settings page, the worker while
dispatching the outbox, which is where nearly every notification is actually
decided. `OFF` has to mean that no job exists -- a job that runs and throws the
mail away is a retry queue full of mail nobody wanted.

What the resolver deliberately does not do is decide _who_ is a recipient.
Whether somebody may still read a page is a different question, asked by
whoever already knows the page, and asked again at send time. A preference
stored yesterday must never be the reason a withdrawn share is still
announced.

## Consequences

- Share mail is switchable, and it is the first notification in this
  deployment that a person can refuse. The switch covers arrival, change and
  withdrawal together, because they are one occasion: somebody who does not
  want to hear about their access changing does not want two thirds of it.
- The settings page moved. Notifications used to be a section under
  "Verbindungen", which is about programs one lets in; a postbox is not one.
  `/einstellungen/benachrichtigungen` now holds both halves, with the
  device-scoped and account-wide sections separated and labelled, rather than a
  matrix of occasion by channel that would offer cells nothing delivers.
- `GET /api/me/notification-preferences` answers the account-wide half only.
  The device half stays on `GET /api/me/push/devices`, where it is one row per
  browser; a route merging the two would have to invent a single value for
  something that is legitimately different on a phone and a desktop.
- A kind reaching a device is written out twice -- `NOTIFICATION_CATALOG` and
  `pushNotificationKinds` -- because the latter has to be a literal type. A
  unit test binds them together, and it is the only thing that does.
- Issues #106 and #107 add senders and catalogue entries, not a preference
  mechanism. That was the point.
- A deployment that never touches the settings page behaves exactly as it did
  before: every default is what the code did unconditionally yesterday.
