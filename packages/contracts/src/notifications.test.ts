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
    ]);
  });

  /**
   * A digest is modelled and nothing collects one yet (issue #106). Offering it
   * would be a switch that quietly delivers nothing, so the catalogue may not
   * name it until a sender exists -- at which point this expectation is what
   * says out loud that the two halves ship together.
   */
  it('offers no digest while nothing collects one', () => {
    for (const kind of notificationKinds) {
      for (const channel of notificationChannels) {
        expect(notificationSupport(kind, channel)?.modes ?? []).not.toContain('DAILY_DIGEST');
      }
    }
  });
});
