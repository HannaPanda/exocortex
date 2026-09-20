# ADR-048: a push subscription is a device, and the worker holds the key

- Status: accepted
- Date: 2026-09-20

## Context

eXocortex is installable as a PWA and has been since the manifest and the
service worker went in. Issue #30 asks the obvious follow-up question, and asks
it honestly: are push notifications worth having here, and what for.

The answer is not "so the app can nag". Everything that happens while somebody
is looking at a page already arrives over the realtime socket, and a
notification for it would be noise. What a notification is good for is the
opposite case: something happened and nobody is looking.

Three such things exist in this deployment today.

**An appointment is about to start.** Reminders already work, and they leave
through `createCommandNotifier`: one configured executable, one configured
target, Hermes' one-shot sender into Telegram. That is a deployment-wide
channel, which means on a deployment with two accounts it tells the wrong
person half the time.

**Somebody commented.** Comments are the one collaborative act here that
expects an answer, and `comment.created` already passes through the outbox
exactly once.

**An agent has something to say.** This is the one that actually motivated the
feature. Hermes and Claude Code run long jobs on this host; when one finishes,
fails, or needs a decision, there is no way for it to reach the person except
by waiting to be asked. A tool that puts a line on a phone closes that loop.

Four questions had to be decided.

**Who owns a preference: a person or a browser?** The obvious model is a
per-user switch, since a person is who gets notified.

**Where does the signing key live?** Web Push needs a VAPID key pair, and
something has to sign with it on every send.

**What happens when a device stops answering?** A push service replies 404 or
410 for a subscription that is over, and something else for a bad afternoon.

**Is the encryption a dependency or ours?** `web-push` is the standard answer
and is MPL-2.0, which [rule 14](../../CLAUDE.md) allows.

## Decision

**A subscription is a device, and the kinds it accepts are a column on it.**
`PushSubscription` carries `kinds`, not the user. A per-person switch cannot
express the thing people actually want, which is that the phone in a pocket
buzzes for an appointment and the desktop at work does not. The settings UI
follows the model rather than hiding it: one row per browser, three switches on
the row. An empty `kinds` is a legitimate state -- registered and silent -- and
it is how somebody keeps the permission without the noise.

The endpoint is unique across the deployment, not per user. A browser profile
mints one endpoint for this application, so registering it again after signing
in as somebody else moves the row to the new account. That is the honest
reading: the person in front of it changed.

**The worker signs, the API never does.** The VAPID private key is in the
worker's environment and nowhere else. The API reads only the public half, to
hand it to a browser that wants to subscribe, and enqueues a job that names a
_person_ rather than a subscription. The API is the process that answers the
public internet; it should not be the process holding a signing key. Naming a
person rather than a device also makes the job idempotent in the way that
matters: which devices hear about it is read at send time, so a switch flipped
a minute ago is obeyed.

The key pair is environment configuration and never a setting, because it is a
credential ([ADR-023](ADR-023-settings-have-a-scope.md)). Absent is an ordinary
state: a deployment without a pair sends no notifications and is otherwise
unchanged. Nothing rotates it automatically, because rotating it invalidates
every subscription -- an endpoint is minted against the public key the browser
was given.

**404 and 410 delete the row; everything else is counted.** A subscription the
push service has forgotten can never come back, so keeping it would be keeping
a device nobody owns. Any other failure is counted on the row and the job is
retried three times with a short backoff; ten consecutive failures retire the
device. Three attempts rather than the usual five because a notification ages
out of usefulness: the fourth would arrive after the appointment.

A job throws only when _every_ device failed retryably. Throwing on a partial
failure would re-deliver to the devices that already had it.

**The encryption is written out here, in `apps/worker/src/push/`.** Not because
the dependency is heavy -- five transitive packages is not much -- but because
RFC 8291 section 5 contains a full worked example, and with the salt and the
ephemeral key pinned the entire ciphertext is a constant. `encrypt.test.ts`
reproduces it byte for byte. A library would have to be believed; this can be
checked, which is the better trade for eighty lines of `node:crypto`.

**Reminders now have two channels and either one is enough.** The command
notifier keeps working exactly as before; push is added beside it and goes to
the calendar account's owner. An appointment counts as announced when _one_
channel accepted it, because the alternative -- marking only when both did --
would re-announce on the working channel every minute until the broken one came
back.

## Consequences

- A person can be notified per device, and a device can be registered and
  silent. There is no per-person switch, and adding one later would mean
  deciding what it does to the rows that disagree with it.
- The API cannot send a notification. Everything goes through the `push` queue,
  which means a notification is never synchronous and the settings page reports
  "queued for n devices" rather than "delivered".
- Comment notifications reach the page's author and the thread's participants,
  filtered by whether they may still read the page -- membership, or an
  unrevoked share resolved against the hierarchy. Nobody else is notified: a
  workspace is not a mailing list, and a notification per comment would be
  switched off within a week, taking the reminders with it.
- `exo_push_send` reaches only the caller's own devices. An account that could
  push to somebody else's phone would be a way to make a stranger's pocket
  buzz, and nothing here needs it.
- Registering a device is the one capability MCP does not have, and it cannot:
  a subscription is minted by a browser's own push service. It is listed in
  `EXEMPT` in `scripts/check-mcp-catalog.mjs` with that reason.
- On iOS a notification requires the app to be on the home screen. The settings
  page says so rather than offering a button that silently does nothing.
- Rotating `VAPID_PRIVATE_KEY` silently retires every device: they keep their
  rows, the sends keep failing, and after ten failures the rows disappear. The
  generator script says so; nothing enforces it.
