# Notifications

Which occasions this deployment tells somebody about, over which channels, and
where the answer to "do you want that" is kept.

The decision behind this file is ADR-052, and ADR-053 for the one pair that
collects. The two transports have their own documents: `docs/mail.md` for how
a mail is built and sent, and ADR-048 for how a device is subscribed and
encrypted to.

## The two axes

An **occasion** is what happened: `SHARE`, `COMMENT`, `CALENDAR`, `AGENT`,
`FAILURE`. A
**channel** is how it travels: `PUSH` or `EMAIL`. They are separate on purpose.
Before issue #105 they were not — push knew three kinds on a device, mail knew
six template names, and the same event was called different things on each
side.

`NOTIFICATION_CATALOG` in `packages/contracts/src/notifications.ts` is the one
table that says which pairs exist. It is not a cross product. A pair appears
there when something actually delivers it, because a switch that reaches no
sender is a promise the deployment does not keep.

| Occasion   | Channel | Modes                            | Default     | Preference lives |
| ---------- | ------- | -------------------------------- | ----------- | ---------------- |
| `SHARE`    | `EMAIL` | `OFF`/`IMMEDIATE`                | `IMMEDIATE` | the account      |
| `COMMENT`  | `PUSH`  | `OFF`/`IMMEDIATE`                | `IMMEDIATE` | the device       |
| `COMMENT`  | `EMAIL` | `OFF`/`IMMEDIATE`/`DAILY_DIGEST` | `OFF`       | the account      |
| `CALENDAR` | `PUSH`  | `OFF`/`IMMEDIATE`                | `IMMEDIATE` | the device       |
| `AGENT`    | `PUSH`  | `OFF`/`IMMEDIATE`                | `IMMEDIATE` | the device       |
| `FAILURE`  | `EMAIL` | `OFF`/`IMMEDIATE`                | `IMMEDIATE` | the account      |

`SHARE` has no push row because a share is not a moment: the person it concerns
is usually not here when it happens, and may have no device registered at all.
`CALENDAR` has no mail row because a reminder that arrives whenever a mail
client next polls is a reminder for the wrong minute.

`COMMENT` is the only pair with both, and the only one that can collect. It is
also the only mail row that is `OFF` by default: push already reaches whoever
registered a device, so nothing is lost by silence, and a deployment that gains
a feature must not thereby start writing to people who never asked it to. A
share, by contrast, is on because a share nobody hears about is a share nobody
uses.

`FAILURE` is one of the owner's automations switching itself off, or the
first failed run of a scheduled one (issue #107, `docs/automations.md`). It is
on by default for the same reason a share is: a rule that stopped working says
so to nobody else, and the owner is the only person who can switch it back on.
It has no push row because what it reports is still true tomorrow. It is not
a channel for background faults in general: a failed queue job, an index that
could not be rebuilt or a lost worker belongs to the logs and the alerts,
because the person reading such a mail is not the person who could fix it.

**The mail an automation sends is not in this table, on purpose** (issue #104,
ADR-054). Everything here is an occasion somebody is _told_ about, where a
default has to be chosen for people who never decided. An `EMAIL_SELF` rule is
the decision: somebody wrote it, named the page and set the time. A switch that
silently stopped it would turn a rule reading "enabled" into one that does
nothing; switching it off is `enabled: false` on the rule, where it was
switched on.

## Where a preference is stored

`storedOn` on the catalogue entry decides, and there are exactly two answers.

**`device`** is ADR-048 unchanged: the `kinds` column on `push_subscription`.
The phone in a pocket and the desktop at work are allowed to disagree, and one
per-person switch cannot say so. Nothing account-wide overrides it.

**`account`** is a row in `notification_preference`, keyed by user, occasion and
channel. An address belongs to a person rather than to a browser.

A check constraint refuses a `PUSH` row in that table outright. Without it
there would be two places to ask about push and the answer that disagreed would
win by accident; dropping it is what a second account-wide channel has to cost,
and that is the right price for the question to be asked.

**An absent row means the catalogue's default**, the same reading an absent
`workspace_setting` gets (ADR-023). Setting a preference back to its default
deletes the row rather than storing the same value, so a default that changes
later moves everybody who never decided — not only the people who never touched
the switch.

## Delivery modes

`OFF`, `IMMEDIATE`, `DAILY_DIGEST`.

The third was in the union before anything produced one: the routing layer had
to be able to answer "queue now, or collect for later" before anything
collected, and adding the mode afterwards would have meant migrating rows that
already said `IMMEDIATE` and guessing which of them meant it. Issue #106 added
the other half, and `COMMENT`/`EMAIL` is so far the only entry that offers it
(ADR-053, `docs/background-jobs.md` for the sweep).

A sender compares against `IMMEDIATE` rather than against `OFF`. A collecting
mode must never fall through to sending at once.

Only mail collects. A digest is a page of text somebody reads when they get
round to it; a push notification is a line on a lock screen at the moment
something happens, and a collected push would arrive as a nudge about something
that stopped being news yesterday. `notifications.test.ts` says so out loud.

Which knobs a digest has, and where: `notifications.digestHour`,
`notifications.digestTimeZone` and
`notifications.commentMailDebounceMinutes`, all deployment-wide (ADR-023).
One mail per person covers every workspace they are in, so the hour it goes
out cannot be a workspace's answer -- and the zone is stated rather than read
off the server, which runs in UTC.

## Asking

`packages/database/src/notification-preferences.ts` is the only place that
answers. It lives beside the schema rather than in a service because both
halves of the deployment ask it: the API while answering the settings page, the
worker while dispatching the outbox, which is where nearly every notification
is actually decided.

| Function                        | Answers                                              |
| ------------------------------- | ---------------------------------------------------- |
| `resolveNotificationMode`       | one person, one pair                                 |
| `filterImmediateRecipients`     | which of these people want it now, in one query      |
| `listNotificationPreferences`   | the settings page and `exo_notification_preferences` |
| `notificationPreferenceRefusal` | why a pair or a mode cannot be stored                |
| `setNotificationPreference`     | store it, or delete the row when it is the default   |

**Ask before enqueueing.** `OFF` has to mean that no job exists: a job that runs
and then throws the mail away is a retry queue full of mail nobody wanted.

**The resolver does not decide who a recipient is.** Whether somebody may still
read the page is a different question, asked by whoever already knows the page
— `comment-notifications.ts` and `share-notifications.ts` — and asked again at
send time. A preference stored yesterday must never be the reason a withdrawn
share is still announced.

## Adding an occasion or a channel

1. Add the value to `notificationKinds` (or `notificationChannels`) in
   `packages/contracts/src/notifications.ts` and to the matching enum in
   `packages/database/prisma/schema.prisma`, with a hand-written migration.
2. Add the catalogue entry — `modes`, `defaultMode`, `storedOn` — **in the same
   commit series as the code that sends it**. An entry without a sender is a
   switch that does nothing.
3. Ask the resolver in the producer, before the `enqueue` call, and compare
   against `IMMEDIATE`.
4. If the channel is mail, follow `docs/mail.md`'s four steps for the template
   itself. The preference decides whether to enqueue; the template decides what
   the mail says.
   If the mode is `DAILY_DIGEST`, there is a fifth thing to decide: what holds
   the occurrences between the event and the mail. ADR-053 answers it for
   comments with a row per owed occurrence, written where the recipient is
   already being decided, carrying a pointer and no text. Do not reconstruct a
   digest from jobs that have already been sent, and do not re-derive its
   recipients from a checkpoint -- that is the recipient logic in a second
   place, reading a world that has moved on.
5. Amend the feature entry `benachrichtigungen-einstellen` in
   `packages/features/src/features/platform.ts`, and this table.

A pair whose preference lives on a device needs no row and no route: the device
list already carries it.

## The surfaces

| Who                    | How                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------- |
| a person, account-wide | `/einstellungen/benachrichtigungen`, section "Per E-Mail"                          |
| a person, per device   | the same page, section "Auf deinen Geräten"                                        |
| an agent, account-wide | `exo_notification_preferences`, `exo_notification_preference_set`                  |
| an agent, per device   | `exo_push_devices`, `exo_push_device_update`                                       |
| the API                | `GET`/`PUT /api/me/notification-preferences`, `GET`/`PATCH /api/me/push/devices/*` |

The page keeps the two sections apart rather than drawing a matrix of occasion
by channel. A matrix would hide the difference between them and would offer
cells that nothing delivers.

Inside the mail section the control follows the pair: two modes are a switch,
three are a select. A switch with three states is a puzzle, and a select with
two entries is a detour around a yes. Both read `modes` from the response
rather than from a list in the browser, so a mode this deployment refuses is
never offered.
