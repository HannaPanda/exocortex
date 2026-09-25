import { describe, expect, it } from 'vitest';

import { notificationKinds, projectBuildErrorKeys, renderErrorKeys } from '@exocortex/contracts';

import { messagesFor, serverTranslator } from './catalog';

/**
 * Codes the API and the browser turn into sentences (issue #98, ADR-062).
 *
 * The contracts hold the closed list and the catalogue holds the words, so
 * nothing but this test notices a code added on one side only. A missing
 * entry would reach a person as a raw key like `errors.worker_lost`.
 */
describe('codes rendered from the catalogue', () => {
  const de = messagesFor('de');

  it('has a sentence for every render failure', () => {
    for (const key of renderErrorKeys) {
      expect(de.render.errors[key], key).toBeTruthy();
    }
  });

  it('has a sentence for every project build failure', () => {
    for (const key of projectBuildErrorKeys) {
      expect(de.projects.buildErrors[key], key).toBeTruthy();
    }
  });

  it('names and explains every notification occasion', () => {
    const t = serverTranslator('de', 'account');
    for (const kind of notificationKinds) {
      expect(t(`notifications.kinds.${kind}.label`).length, kind).toBeGreaterThan(0);
      expect(t(`notifications.kinds.${kind}.description`).length, kind).toBeGreaterThan(20);
    }
  });

  it('falls back to German for a locale that has not caught up', () => {
    expect(serverTranslator('pl', 'render')('errors.worker_lost').length).toBeGreaterThan(0);
  });
});
