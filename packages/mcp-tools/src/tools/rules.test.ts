import { describe, expect, it } from 'vitest';

import { ExocortexApiError, type ExocortexApiClient } from '../client.js';

import { rulesLoadTool } from './rules.js';

/** A client that answers every request with the same failure. */
function failingClient(status: number, code: string): ExocortexApiClient {
  const fail = async (): Promise<never> => {
    throw new ExocortexApiError(code, 'Document does not exist', status, 'corr-1');
  };
  return { request: fail, upload: fail };
}

describe('rulesLoadTool', () => {
  it('names the likely cause when the identifier is one character short', async () => {
    // What a run did on 2026-09-21: it copied `ybnvnqxaoleiocapa7n9nujd` out of
    // the system prompt without its last character, and the API's "does not
    // exist" left it nothing to do but list the rules and try again.
    const client = failingClient(403, 'document_access_denied');

    const result = await rulesLoadTool.run(client, { documentId: 'ybnvnqxaoleiocapa7n9nuj' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('23 Zeichen lang');
    expect(result.text).toContain('24');
    expect(result.text).toContain('exo_rules_list');
  });

  it('says nothing about the length when the identifier is a full one', async () => {
    const client = failingClient(404, 'document_not_found');

    const result = await rulesLoadTool.run(client, { documentId: 'ybnvnqxaoleiocapa7n9nujd' });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('Zeichen lang');
    expect(result.text).toContain('exo_rules_list');
  });

  it('lets every other failure through, because it is not about the identifier', async () => {
    const client = failingClient(500, 'internal_error');

    await expect(
      rulesLoadTool.run(client, { documentId: 'ybnvnqxaoleiocapa7n9nujd' }),
    ).rejects.toThrow(ExocortexApiError);
  });
});
