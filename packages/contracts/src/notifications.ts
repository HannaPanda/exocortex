import { z } from 'zod';

/**
 * What a person may be told about, and over which transport (issue #105).
 *
 * Before this file there were two unrelated vocabularies. Push knew three
 * `PushNotificationKind`s stored on a device (ADR-048); mail knew six
 * `MailTemplateName`s and no switch at all, so a share notification went out
 * whether or not anybody wanted it. Neither is the thing a person means when
 * they say "tell me about comments but not by mail": that sentence names an
 * *occasion* and a *channel*, and the two are separate questions.
 *
 * So the occasion is `NotificationKind` and the transport is
 * `NotificationChannel`, and `NOTIFICATION_CATALOG` is the one table that says
 * which pairs exist, which delivery modes each pair allows, what happens when
 * nobody has decided, and -- the part that keeps ADR-048 intact -- whether the
 * preference for that pair lives on a device or on the account.
 *
 * The catalogue is deliberately not a cross product. A pair that appears here
 * is a pair something actually delivers: a switch that reaches no sender is a
 * promise the deployment does not keep.
 */

export const notificationKinds = ['SHARE', 'COMMENT', 'CALENDAR', 'AGENT'] as const;
export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationChannels = ['PUSH', 'EMAIL'] as const;
export const notificationChannelSchema = z.enum(notificationChannels);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/**
 * How much of a channel a person wants for one occasion.
 *
 * `DAILY_DIGEST` was in this union before anything produced one: the routing
 * layer had to be able to answer "queue now, or collect for later" before
 * anything collected, and a mode added afterwards would have meant migrating
 * rows that already said `IMMEDIATE`. Issue #106 added the other half -- the
 * `COMMENT`/`EMAIL` entry below offers it, and `send-comment-digests` sends
 * it (ADR-053).
 */
export const notificationDeliveryModes = ['OFF', 'IMMEDIATE', 'DAILY_DIGEST'] as const;
export const notificationDeliveryModeSchema = z.enum(notificationDeliveryModes);
export type NotificationDeliveryMode = z.infer<typeof notificationDeliveryModeSchema>;

/**
 * Where the answer for one pair is kept.
 *
 * `device` is ADR-048's model and stays exactly as it was: the phone in a
 * pocket and the desktop at work hold their own `kinds` column, because a
 * per-person push switch cannot express what people actually want. `account`
 * is a row in `notification_preference`, because an address belongs to a
 * person and not to a browser.
 */
export const notificationPreferenceScopes = ['device', 'account'] as const;
export const notificationPreferenceScopeSchema = z.enum(notificationPreferenceScopes);
export type NotificationPreferenceScope = z.infer<typeof notificationPreferenceScopeSchema>;

export interface NotificationChannelSupport {
  /** Every mode a person may pick for this pair. Never empty. */
  readonly modes: readonly NotificationDeliveryMode[];
  /** What holds while nobody has decided. Always one of `modes`. */
  readonly defaultMode: NotificationDeliveryMode;
  readonly storedOn: NotificationPreferenceScope;
}

export interface NotificationKindEntry {
  /** German, and the same words the settings page and an agent both get. */
  readonly label: string;
  readonly description: string;
  readonly channels: Readonly<Partial<Record<NotificationChannel, NotificationChannelSupport>>>;
}

/** Off, or delivered the moment it happens. What a switch expresses. */
const SWITCH: readonly NotificationDeliveryMode[] = ['OFF', 'IMMEDIATE'];

/**
 * The same, plus collecting for later. What a channel expresses that can also
 * carry several occurrences in one message (issue #106).
 *
 * Only mail offers it. A digest is a page of text somebody reads when they get
 * round to it, and a push notification is a line on a lock screen at the
 * moment something happens -- a collected push would arrive as a nudge about
 * something that stopped being news yesterday.
 */
const SWITCH_WITH_DIGEST: readonly NotificationDeliveryMode[] = [
  'OFF',
  'IMMEDIATE',
  'DAILY_DIGEST',
];

export const NOTIFICATION_CATALOG: Readonly<Record<NotificationKind, NotificationKindEntry>> = {
  SHARE: {
    label: 'Geteilte Seiten',
    description:
      'Jemand teilt eine Seite mit dir, ändert deine Rechte daran oder nimmt sie dir wieder weg.',
    channels: {
      // Mail and nothing else: a share is the one notification whose whole
      // point is to reach somebody who is not looking at this deployment, and
      // who may not have a device registered here at all (issue #103).
      EMAIL: { modes: SWITCH, defaultMode: 'IMMEDIATE', storedOn: 'account' },
    },
  },
  COMMENT: {
    label: 'Kommentare',
    description:
      'Jemand kommentiert eine Seite, die du geschrieben hast, oder antwortet in einem Faden, in dem du schon steckst.',
    channels: {
      PUSH: { modes: SWITCH, defaultMode: 'IMMEDIATE', storedOn: 'device' },
      /**
       * Mail as well, and the only pair that can collect (issue #106,
       * ADR-053). A comment is the one occasion here that arrives in bursts:
       * a thread is four replies in ten minutes, and four letters about them
       * is how somebody learns to filter this sender into a folder.
       *
       * `OFF` by default, unlike the share mail beside it. Push already
       * reaches whoever registered a device, so nothing is lost by silence
       * here -- and a deployment that gains a feature must not thereby start
       * writing to people who never asked it to.
       */
      EMAIL: { modes: SWITCH_WITH_DIGEST, defaultMode: 'OFF', storedOn: 'account' },
    },
  },
  CALENDAR: {
    label: 'Termine',
    description: 'Kurz bevor ein Termin aus deinem Kalender anfängt.',
    channels: {
      // No mail, on purpose: a reminder that arrives whenever a mail client
      // next polls is a reminder for the wrong minute.
      PUSH: { modes: SWITCH, defaultMode: 'IMMEDIATE', storedOn: 'device' },
    },
  },
  AGENT: {
    label: 'Nachrichten von Agenten',
    description:
      'Ein Agent meldet sich: ein langer Lauf ist fertig, etwas ist schiefgegangen, eine Frage blockiert.',
    channels: {
      PUSH: { modes: SWITCH, defaultMode: 'IMMEDIATE', storedOn: 'device' },
    },
  },
};

/** The pairs whose answer is a row on the account, in catalogue order. */
export const ACCOUNT_NOTIFICATION_PAIRS: readonly {
  readonly kind: NotificationKind;
  readonly channel: NotificationChannel;
  readonly support: NotificationChannelSupport;
}[] = notificationKinds.flatMap((kind) =>
  notificationChannels.flatMap((channel) => {
    const support = NOTIFICATION_CATALOG[kind].channels[channel];
    return support !== undefined && support.storedOn === 'account'
      ? [{ kind, channel, support }]
      : [];
  }),
);

/**
 * The support entry for a pair, or undefined when the pair does not exist.
 *
 * Every caller that decides whether to deliver goes through this rather than
 * reading the record directly, so "this combination was never built" and "this
 * person switched it off" stay two different answers.
 */
export function notificationSupport(
  kind: NotificationKind,
  channel: NotificationChannel,
): NotificationChannelSupport | undefined {
  return NOTIFICATION_CATALOG[kind].channels[channel];
}

export const notificationPreferenceSchema = z.object({
  kind: notificationKindSchema,
  channel: notificationChannelSchema,
  label: z.string(),
  description: z.string(),
  /** Every mode this pair allows, so a client never offers one that is refused. */
  modes: z.array(notificationDeliveryModeSchema).min(1),
  defaultMode: notificationDeliveryModeSchema,
  /** What holds right now: the stored row, or `defaultMode` when there is none. */
  mode: notificationDeliveryModeSchema,
});
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/**
 * The account-wide answers only.
 *
 * The device-scoped half is not repeated here: it is one row per browser and
 * `GET /api/me/push/devices` already answers it. A response that carried both
 * would have to invent a single value for something that legitimately differs
 * between a phone and a desktop.
 */
export const notificationPreferencesResponseSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
});
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;

export const updateNotificationPreferenceRequestSchema = z.object({
  kind: notificationKindSchema,
  channel: notificationChannelSchema,
  mode: notificationDeliveryModeSchema,
});
export type UpdateNotificationPreferenceRequest = z.infer<
  typeof updateNotificationPreferenceRequestSchema
>;
