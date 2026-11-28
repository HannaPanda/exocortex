import { describe, expect, it, vi } from 'vitest';

import { type DocumentGrant } from '@exocortex/auth';

import { AppError } from '../common/app-error';

import { type CoverPayerLookups, resolveCoverPayer } from './cover-payer';

/**
 * Who pays for a cover (issue #264): the page's workspace for a member, the
 * reader's own for somebody who reached the page through a share. No
 * database: the two lookups are stubs, so every case is a question of what
 * was asked and what was answered.
 */

const membership: DocumentGrant = { source: 'membership' };
const share: DocumentGrant = {
  source: 'share',
  shareId: 'share1',
  rootId: 'doc1',
  scope: 'PAGE_ONLY',
  permission: 'WRITE',
};

function lookups(input: {
  run?: { workspaceId: string; createdById: string } | null;
  own?: string | null;
}) {
  return {
    runWorkspace: vi.fn<CoverPayerLookups['runWorkspace']>(async () => input.run ?? null),
    firstOwnWorkspace: vi.fn<CoverPayerLookups['firstOwnWorkspace']>(async () => input.own ?? null),
  };
}

describe('resolveCoverPayer', () => {
  it("keeps a member on the page's workspace, inside a run or not", async () => {
    const asked = lookups({ run: { workspaceId: 'other-ws', createdById: 'u1' }, own: 'own-ws' });

    for (const runId of [undefined, 'run1']) {
      await expect(
        resolveCoverPayer(
          { context: { workspaceId: 'page-ws', grant: membership }, userId: 'u1', runId },
          asked,
        ),
      ).resolves.toEqual({ workspaceId: 'page-ws', source: 'page' });
    }
    expect(asked.runWorkspace).not.toHaveBeenCalled();
    expect(asked.firstOwnWorkspace).not.toHaveBeenCalled();
  });

  it("puts a reader's run on the run's workspace, read from the signed run id", async () => {
    const asked = lookups({ run: { workspaceId: 'reader-ws', createdById: 'u1' }, own: 'first' });

    await expect(
      resolveCoverPayer(
        { context: { workspaceId: 'page-ws', grant: share }, userId: 'u1', runId: 'run1' },
        asked,
      ),
    ).resolves.toEqual({ workspaceId: 'reader-ws', source: 'run' });
    expect(asked.runWorkspace).toHaveBeenCalledWith('run1');
    // The run's own workspace wins over the reader's first one.
    expect(asked.firstOwnWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a run id that names nobody, or somebody else', async () => {
    for (const run of [null, { workspaceId: 'their-ws', createdById: 'someone-else' }]) {
      await expect(
        resolveCoverPayer(
          { context: { workspaceId: 'page-ws', grant: share }, userId: 'u1', runId: 'run1' },
          lookups({ run, own: 'own-ws' }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('puts a reader outside a run on their first own workspace', async () => {
    const asked = lookups({ own: 'own-ws' });

    await expect(
      resolveCoverPayer(
        { context: { workspaceId: 'page-ws', grant: share }, userId: 'u1', runId: undefined },
        asked,
      ),
    ).resolves.toEqual({ workspaceId: 'own-ws', source: 'own_workspace' });
    expect(asked.firstOwnWorkspace).toHaveBeenCalledWith('u1');
  });

  it('refuses a reader with no workspace of their own instead of billing the page', async () => {
    const refusal = resolveCoverPayer(
      { context: { workspaceId: 'page-ws', grant: share }, userId: 'u1', runId: undefined },
      lookups({ own: null }),
    );

    await expect(refusal).rejects.toBeInstanceOf(AppError);
    await expect(refusal).rejects.toMatchObject({ code: 'ai_image_no_own_workspace' });
  });
});
