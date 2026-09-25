# Mail

How this deployment sends e-mail, and which of the two ways a given mail takes.

Issue #102 split one from the other. Before it, SMTP lived in
`packages/auth/src/mailer.ts` and knew three mails: verification, password
reset, invitation. That was true to what the deployment did, and it stopped
being true the moment anything other than authentication wanted to write to
somebody — a share, an automation, a digest — because reaching a relay then
meant depending on the authentication library.

## The two halves

**Synchronous, in the API.** The mails a request waits on. Better Auth's own
callbacks (`EMAIL_VERIFICATION`, `PASSWORD_RESET`) and the invitation, whose
response carries `emailSent` and therefore cannot be answered by a job that has
not run yet. These go straight through the `MAILER` provider in
`apps/api/src/platform/platform.module.ts`, and a relay that is down makes the
request say so.

**Asynchronous, in the worker.** Everything else: the share notifications of
issue #103, the comment digests of #106, the automation mail of #104, and
the failure mails of #107. They are enqueued on the `mail` queue and sent by `createMailDeliveryProcessor`, so a relay having
a bad five minutes delays a mail instead of failing whatever caused it.
`docs/background-jobs.md` describes the queue, its retry policy and its
deduplication.

Both processes build their transport with the same `createMailerFromEnv` from
the same `SMTP_*` variables. There is one relay, configured in one place, and
`packages/mail` is the only code in this repository that opens a connection to
it.

## The packages

| Path                                          | Owns                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/mail/src/transport.ts`              | the SMTP connection, TLS, credentials, failure classification          |
| `packages/mail/src/templates/`                | which words go where, as layout blocks; the words are in the catalogue |
| `packages/mail/src/layout/`                   | the one layout: blocks become HTML and plain text; the mail theme      |
| `packages/mail/src/render.ts`                 | template name plus values becomes subject, text and HTML               |
| `packages/mail/src/examples.ts`               | one example message per template, for the tests and the preview        |
| `packages/mail/src/translator.ts`             | the reader's `mail` namespace and how a date is written for them       |
| `packages/mail/src/mailer.ts`                 | transport plus catalogue, and what may be logged                       |
| `packages/contracts/src/mail.ts`              | the template catalogue as a zod union                                  |
| `share-notifications.ts` (worker)             | which grant change becomes which mail, and to whom                     |
| `comment-digests.ts` (worker)                 | which collected comments become one mail, and to whom                  |
| `automation/mail.ts` (worker)                 | which page an `EMAIL_SELF` rule sends, and that it goes to its owner   |
| `failure-notifications.ts` (worker)           | whether a stopped automation is still news, and to whom                |
| `apps/worker/src/processors/mail-delivery.ts` | one job, one SMTP hop, retry or do not                                 |

`packages/mail` may see `@exocortex/contracts`, `@exocortex/logger` and
`@exocortex/i18n` (for its words) and nothing else. In particular not `@exocortex/database`: a package that could look
up an address would sooner or later be asked to decide who gets mail, and that
decision belongs to whoever already knows whether the person still has access.

## Adding a mail

1. Add a variant to `mailMessageSchema` in `packages/contracts/src/mail.ts`. It
   carries the handful of values the template needs — a name, a title, a link,
   a date as an ISO string — and never a rendered subject or body, and never a
   page's text.
2. Write the template in `packages/mail/src/templates/`, returning a
   `MailContent`: a subject, a preheader, a heading and a list of blocks. No
   markup and no layout -- see "The layout" below. Every word a reader sees
   comes from the `mail` namespace (`packages/i18n/src/messages/de/mail.json`,
   German at the source, then `pnpm i18n:translate`) through the
   `MailLanguage` the template is handed; dates go through `formatDay` or an
   `Intl` formatter on `language.locale`, never a fixed `'de-DE'`.
3. Add the branch to `mailContent` in `render.ts`. The switch is exhaustive
   over a closed union, so forgetting this is a type error rather than an
   empty mail.
4. Add an example to `MAIL_EXAMPLES` in `examples.ts`. The record is typed
   over every template, so this too is a type error when it is missing, and it
   is what puts the new mail through the layout tests and into the preview.
5. Enqueue it: `queues.enqueue(QUEUE_NAMES.mail, { correlationId, recipient, mail, locale })`,
   with `locale` resolved from the recipient (see "The reader's language").
   If the event behind it can be dispatched twice, pass a `jobId` derived from
   the event.

A template is never rendered by its caller. That is the rule the shape exists
to enforce: everything that will enqueue mail from here on carries text a
person or a model wrote, and a queue that accepts prose is a relay for whatever
reaches it.

## The reader's language

A mail is written in the language of the person who reads it (issue #98,
ADR-062), never in the requester's by accident. `renderMail(message, locale)`,
`mailContent(message, locale)` and `Mailer.send({ to, message, locale })` all
take it, and none of them defaults it: only the caller knows who the reader is.
The locale also becomes the HTML part's `lang`, and it decides how dates are
written and which quotation marks the layout puts around a quoted comment.

Who decides, per mail:

| Mail                              | Locale                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| share, comment digest, automation | the recipient's `User.locale` through `resolveLocale({ preference })`, German when they never chose    |
| verification, password reset      | the account's `User.locale`, else the cookie and `Accept-Language` of the request that caused the mail |
| invitation                        | `Invitation.locale`, chosen by the inviter; without one the inviter's own `User.locale`, else German   |

Better Auth's two mails go through the `mailLocale` port of `createAuth`,
which the API answers with `readerLocale`; `packages/auth` depends on neither
the catalogue nor the negotiation. An invitation is the one mail to somebody
without an account, so the inviter chooses: the dialog offers every language
by its endonym and starts at the inviter's own interface language, and
`exo_invitation_create` takes the same optional `locale`. Accepting the
invitation copies it to the new account's `User.locale`; an invitation with
none leaves the account undecided, so its browser decides.

A queued job carries the locale beside the address (`mailDeliveryJobSchema`),
resolved by the producer that already read the account. The field defaults to
German, so a job that was waiting in Redis during a deploy still parses. The
few words a producer supplies itself (the name of an untitled page, "Jemand"
for an author without a name) come from the same namespace in the same
language.

## The layout

Every mail is drawn by one function, `composeMail` in
`packages/mail/src/layout/compose.ts` (issue #109). A template says what a mail
says; the layout decides what that looks like, and it produces both parts of
the message from the same `MailContent`, so the plain-text part is never a
stripped copy of the HTML and cannot drift from it. The transport sends them
together as `multipart/alternative`.

A template builds its body from a closed set of blocks: `paragraph`, `action`
(the one button), `link`, `facts` (label and value), `notice`, `section` (one
group of a digest) and `excerpt` (text shown as written). Every block carries
strings only, and every string is escaped on its way into the HTML, so a page
title, a comment, a person's name or an automation's output can never become a
tag or a style. An `href` is only written for `http` and `https`. The page an
`EMAIL_SELF` rule sends is an `excerpt`: its Markdown arrives as Markdown. A
mail that should ever carry rendered rich content gets a block of its own for
it, decided on purpose, never a string that happens to be trusted.

The HTML is written for mail clients rather than browsers: tables for layout,
every style inline, no script, no web font, no image, a sheet of at most
600 px that narrows with the screen, and an address written out under every
button. Nothing a reader needs depends on CSS arriving. The page asks for
`color-scheme: light`; dark mode is left to the clients that force one.

The look lives in `packages/mail/src/layout/theme.ts`: colours by role (sheet,
header, action, link, ...), the font stacks, the width and the radius. It is
the mail's own token layer because a mail cannot read `tokens.css`, and it is
the one file to change when the corporate design moves. Its current values
are derived from the three brand colours and are a starting point, not a
decision about the CD.

`src/layout/__snapshots__/base.html` pins the base template with every block
in it. A change to that file is a change to every mail this deployment sends;
commit it with a sentence saying why.

To look at the mails: `pnpm --filter @exocortex/mail preview` writes every
example as HTML and text into `packages/mail/mail-preview/` (git ignores it)
with an `index.html`; `-- --locale en` renders them in another language, and
`-- --smtp 127.0.0.1:1026` also sends them to Mailpit,
whose UI (http://127.0.0.1:8026) has an HTML compatibility check. The flag
takes a host and a port and no credentials, and the script never reads
`SMTP_*`, so it cannot reach the production relay.

## Which change sends which mail

Only a grant that names an account, and only these changes to it (issue #103):

| What happened                                        | Template        |
| ---------------------------------------------------- | --------------- |
| a page was shared with an account                    | `SHARE_GRANTED` |
| `READ` became `WRITE`, or the other way round        | `SHARE_CHANGED` |
| `PAGE_ONLY` became `SUBTREE`, or the other way round | `SHARE_CHANGED` |
| an expiry was set, removed or moved                  | `SHARE_CHANGED` |
| the grant was withdrawn                              | `SHARE_REVOKED` |

Since issue #105 all five of them are one switch, `SHARE` over `EMAIL`, and the
grantee owns it. It is on by default — a share nobody hears about is a share
nobody uses — and switching it off means no job is enqueued at all rather than
a job that runs and throws the mail away. One switch covers arrival, change and
withdrawal together, because they are one occasion. `docs/notifications.md` has
the model.

Nothing else does, and three cases are deliberate rather than missing:

- **A public link sends nothing**, whether it is created, rotated or withdrawn.
  It names nobody, so the only address available would be the one of the person
  who just clicked the button.
- **Moving a page into a shared subtree sends nothing.** It changes what the
  holder of that subtree can reach, and it writes no share row: one
  reorganization can carry a hundred pages, and a mail per page is how a useful
  notification becomes a filter rule. The move dialog warns the person doing it
  instead (`docs/sharing.md`).
- **An update that changes none of the four fields sends nothing**, so a dialog
  that submits every field on every save does not post somebody a letter saying
  nothing happened.

The mail is built from the state that holds when the dispatcher reaches the
event, not from the request that caused it: the address comes from the
grantee's account, a switched-off account is skipped, the grantee's own
preference is read then and not when the share was written, and a grant
withdrawn in between is not announced as an arrival. The withdrawal mail is the one that
says least on purpose -- the page's title, which the first mail already
carried, and a link to the list of what is still shared. Not a link into the
page, because the reader can no longer open it.

## Comment mail

One template, `COMMENT_DIGEST`, for both modes the `COMMENT`/`EMAIL` pair
offers (issue #106, ADR-053). `IMMEDIATE` is a digest of the last couple of
minutes and `DAILY_DIGEST` is a digest of a day; a second "one new comment"
template would be the same words with the plural removed, kept in step by hand
for ever.

It carries previews and links and never a whole comment: about 140 characters
per comment, at most five comments per page and ten pages per mail, with the
remainder stated as a count. The payload is bounded twice -- the producer caps
the lists, `mailMessageSchema` refuses anything longer.

Who gets it, and what is in it, is decided by `comment-digests.ts` at the
moment of sending and not when the comment was written:
`docs/background-jobs.md` describes the sweep, and ADR-053 why the thing in
between is a row per owed comment rather than a checkpoint.

## Automation mail

`EMAIL_SELF` is the one action that sends mail, and `AUTOMATION_PAGE` is the
one template that carries a page's text rather than a link to it (issue #104,
ADR-054). Both are the same decision seen from two sides: the action has no
recipient field anywhere, the address is read from the rule's owner when the
mail is queued, and so the worst this template can do is post somebody their
own page.

That is also the condition under which it stays defensible. If a rule ever gets
to name an address, this variant goes back to being a link and the subject
stops being free text. `docs/automations.md` has the action; ADR-054 has the
reasoning.

## Failure mail

`AUTOMATION_DISABLED` and `AUTOMATION_RUN_FAILED` tell a rule's owner that it
stopped working (issue #107). Their reason is a name from
`automationFailureReasonSchema`, which the template turns into a sentence; the
error text never enters the payload, because it can carry whatever a remote
server or a model said. The time is shown in `notifications.digestTimeZone`,
which the producer puts in the payload since the template cannot read
settings. Which failure sends which one is in `docs/automations.md`.

## Why a template and not a subject and a body

The same reasoning as ADR-030's fence around foreign text. A mail leaves this
deployment, arrives somewhere nobody here controls, and carries our `From:`
address while it does. A payload holding a subject and a body would let
whatever can enqueue a job choose both — which, once automations can send mail
(#104), includes a rule a model helped write. Naming a template instead bounds
what a mail can say to what somebody wrote in this repository, and bounds what
it can carry to a handful of short fields.

## Acceptance is not delivery

`MailAcceptance` is what the relay said: it has the message and owes us the
next hop. It is not delivery, it is not a read, and no log line, UI string or
run log may call it `zugestellt`. The only thing that could later be matched
against a bounce is `messageId`.

## What is logged

The template name, the recipient's **domain**, and the relay's message id. Not
the address, not the subject, not a line of the body. `recipient` and `mail`
are in the logger's redaction list (`packages/logger/src/redaction.ts`) as a
second line of defence, so a later `logger.error(..., { payload })` cannot
quietly turn a log file into somebody's post — the same reason `prompt` and
`messages` are in that list.

## Configuration

`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and `SMTP_USER`/`SMTP_PASSWORD` as a
pair. Supplying credentials switches the transport to `requireTLS`, so
nodemailer aborts rather than falling back to a plaintext session; port 465 is
implicit TLS and 587 is STARTTLS. Locally this is Mailpit, which wants neither.

The credentials stay environment variables and never become settings rows
(ADR-023): a relay password is a credential, and credentials do not go in the
`setting` table.

A deployment with no relay is not a failure state. `createMailerFromEnv` hands
back a mailer that logs what it would have sent, every queued job succeeds, and
nothing else about the deployment changes.
