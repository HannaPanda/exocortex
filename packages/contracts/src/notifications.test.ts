import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_NOTIFICATION_PAIRS,
  NOTIFICATION_CATALOG,
  notificationChannels,
  notificationKinds,
  notificationSupport,
} from './notifications';
import { pushNotificationKinds } from './push';

describe('the notification catalogue', () => {
  it('offers only modes it also calls the default', () => {
    for (const kind of notificationKinds) {
      for (const channel of notificationChannels) {
        const support = notificationSupport(kind, channel);
        if (support === undefined) continue;
        expect(support.modes.length, `${kind}/${channel} offers nothing`).toBeGreaterThan(0);
        expect(support.modes, `${kind}/${channel} defaults to a mode it refuses`).toContain(
          support.defaultMode,
        );
      }
    }
  });

  it('describes every occasion in words a person would recognise', () => {
    for (const kind of notificationKinds) {
      const entry = NOTIFICATION_CATALOG[kind];
      expect(entry.label.length, `${kind} has no label`).toBeGreaterThan(0);
      expect(entry.description.length, `${kind} is not explained`).toBeGreaterThan(20);
      expect(Object.keys(entry.channels).length, `${kind} reaches nobody`).toBeGreaterThan(0);
    }
  });

  /**
   * The one that matters. `pushNotificationKinds` is written out by hand so it
   * is a literal type, which means nothing but this test stops it drifting from
   * the catalogue -- and a kind the catalogue calls push-capable while the push
   * schema refuses it would be a switch on the settings page that the API then
   * rejects.
   */
  it('agrees with the push schema about which occasions reach a device', () => {
    const fromCatalog = notificationKinds.filter(
      (kind) => notificationSupport(kind, 'PUSH') !== undefined,
    );
    expect([...pushNotificationKinds].sort()).toEqual([...fromCatalog].sort());
  });

  it('keeps every device-scoped pair out of the account-wide list', () => {
    for (const pair of ACCOUNT_NOTIFICATION_PAIRS) {
      expect(pair.support.storedOn).toBe('account');
    }
    expect(ACCOUNT_NOTIFICATION_PAIRS.map((pair) => `${pair.kind}/${pair.channel}`)).toEqual([
      'SHARE/EMAIL',
      'COMMENT/EMAIL',
      'FAILURE/EMAIL',
    ]);
  });

  /**
   * A digest is a thing a mail can be and a push cannot (issue #106). It said
   * so before by naming nobody at all; now that `send-comment-digests` exists
   * it says which side of the line each channel is on, which is what stops a
   * later pair from quietly offering a collected push nothing collects.
   */
  it('offers a digest on mail and never on push', () => {
    for (const kind of notificationKinds) {
      expect(notificationSupport(kind, 'PUSH')?.modes ?? []).not.toContain('DAILY_DIGEST');
    }
    expect(notificationSupport('COMMENT', 'EMAIL')?.modes).toContain('DAILY_DIGEST');
  });

  /**
   * The one pair that collects must not arrive by default. Comment mail is
   * `OFF` until somebody asks for it: push already reaches whoever registered
   * a device, and a deployment that gains a feature must not thereby start
   * writing to people who never asked it to.
   */
  it('keeps comment mail off until it is asked for', () => {
    expect(notificationSupport('COMMENT', 'EMAIL')?.defaultMode).toBe('OFF');
  });

  /**
   * The failure mail starts out on (issue #107). A rule that switched itself
   * off does nothing until somebody notices, and nothing else would tell them.
   */
  it('reports a failed automation by mail unless somebody switches it off', () => {
    expect(notificationSupport('FAILURE', 'EMAIL')?.defaultMode).toBe('IMMEDIATE');
    expect(notificationSupport('FAILURE', 'PUSH')).toBeUndefined();
  });
});
