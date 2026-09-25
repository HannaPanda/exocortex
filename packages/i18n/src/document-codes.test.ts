import { describe, expect, it } from 'vitest';

import {
  CHAT_COMMANDS,
  documentCoverErrorDetailSchema,
  documentDiffNoticeSchema,
  FORMULA_ERROR_CODES,
  overviewErrorDetailSchema,
} from '@exocortex/contracts';

import { messagesFor } from './catalog';

/**
 * Codes the server sends and the browser words (issue #98): formula and
 * rollup problems, overview and cover failures, the notices of a snapshot
 * comparison, and the command list `/help` prints. A code on one side only
 * would reach a person as a raw key.
 */
describe('document and database codes rendered from the catalogue', () => {
  const de = messagesFor('de');

  it('has a sentence for every formula error', () => {
    for (const code of FORMULA_ERROR_CODES) {
      expect(de.database.formulaErrors.codes[code], code).toBeTruthy();
    }
  });

  it('has a sentence for every overview and cover failure', () => {
    for (const option of overviewErrorDetailSchema.options) {
      const code = option.shape.code.value;
      expect(de.document.overview.errors[code], code).toBeTruthy();
    }
    for (const option of documentCoverErrorDetailSchema.options) {
      const code = option.shape.code.value;
      expect(de.document.cover.generationErrors[code], code).toBeTruthy();
    }
  });

  it('has a sentence for every comparison notice', () => {
    const keys = { older_schema: 'olderSchema', truncated: 'truncated' } as const;
    for (const option of documentDiffNoticeSchema.options) {
      const code = option.shape.code.value;
      expect(de.document.snapshotDiff.notices[keys[code]], code).toBeTruthy();
    }
  });

  it('describes every chat command for /help', () => {
    for (const command of CHAT_COMMANDS) {
      expect(de.commands.help.descriptions[command.name], command.name).toBeTruthy();
    }
  });
});
