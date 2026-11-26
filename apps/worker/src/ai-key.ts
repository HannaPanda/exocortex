import { decryptCredential, parseCredentialKey } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
import { type AiRunKeyUnreadableArgs } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

/**
 * Whose provider key pays for a run (issue #52, AP7, ADR-023).
 *
 * The worker is the only process that ever holds a workspace's key in the
 * clear, and only for the length of one provider call: the API stores the
 * ciphertext and never reads it back, and nothing here logs or returns the
 * value anywhere but into the provider it was meant for.
 *
 * The boundary is deliberately "what a run spends". An `AiRun` and the vision
 * companion calls inside it are paid for by the workspace's key when it has
 * one, and so is a page cover drawn for the workspace (issue #252, ADR-090);
 * the deployment-wide machinery around them (search embeddings, memory
 * capture and consolidation) stays on the deployment key.
 * Embeddings must, under ADR-020: index and query have to live in one vector
 * space, and two accounts embedding under two keys against one index is the
 * failure that looks exactly like a healthy deployment finding nothing.
 *
 * A workspace that has a key of its own is never paid for by the deployment's
 * instead (issue #260, ADR-091). When its stored row cannot be read, because
 * it does not decrypt or because this deployment has no usable encryption key
 * at all, the resolver throws `WorkspaceKeyUnreadableError` and the caller ends
 * its work with that reason. Only a workspace without a row runs on the
 * deployment's key.
 */

export interface ResolvedAiKey {
  apiKey: string;
  /** Whether the key above is the workspace's own. Recorded on the run. */
  usedOwnKey: boolean;
}

/** The error code of a run refused for a workspace key it cannot read (issue #260). */
export const AI_KEY_UNREADABLE = 'ai_key_unreadable';

/** Why a workspace's own key cannot be read; the run and the cover say which. */
export type WorkspaceKeyUnreadableReason = AiRunKeyUnreadableArgs['reason'];

/**
 * The workspace has a key of its own, and this deployment cannot read it.
 *
 * Thrown rather than answered with the deployment's key: whoever brought a key
 * did so to carry their own costs, and the deployment's operator never agreed
 * to carry them instead. The message names the reason and nothing about the
 * key, so it is safe for the log and the run.
 */
export class WorkspaceKeyUnreadableError extends Error {
  constructor(readonly reason: WorkspaceKeyUnreadableReason) {
    super(
      reason === 'noEncryptionKey'
        ? 'The workspace has its own AI key, but this deployment has no usable CREDENTIAL_ENCRYPTION_KEY to read it'
        : "The workspace's own AI key could not be decrypted with this deployment's CREDENTIAL_ENCRYPTION_KEY",
    );
    this.name = 'WorkspaceKeyUnreadableError';
  }
}

/**
 * The key that pays for `workspaceId`'s work. Throws
 * `WorkspaceKeyUnreadableError` for a stored key that cannot be read.
 */
export type AiKeyResolver = (workspaceId: string) => Promise<ResolvedAiKey>;

export function createAiKeyResolver(input: {
  prisma: PrismaClient;
  env: WorkerEnv;
  logger: Logger;
}): AiKeyResolver {
  const deploymentKey: ResolvedAiKey = {
    apiKey: input.env.OPENROUTER_API_KEY ?? '',
    usedOwnKey: false,
  };

  // Parsed once: a malformed `CREDENTIAL_ENCRYPTION_KEY` must not stop the
  // worker from booting. It means no workspace key can be read, so the work of
  // a workspace that stored one ends with that reason below.
  let encryptionKey: Buffer | null = null;
  try {
    encryptionKey = parseCredentialKey(input.env.CREDENTIAL_ENCRYPTION_KEY);
  } catch (error: unknown) {
    input.logger.error('Ignoring CREDENTIAL_ENCRYPTION_KEY: it is not usable', error);
  }

  return async (workspaceId: string): Promise<ResolvedAiKey> => {
    // The row is looked up even when nothing could decrypt it: a deployment
    // that lost its encryption key still has to know which workspaces brought
    // a key of their own, or every one of them would silently run on the
    // deployment's account.
    const row = await input.prisma.workspaceCredential.findUnique({
      where: { workspaceId_purpose: { workspaceId, purpose: 'AI_OPENROUTER' } },
    });
    if (row === null) return deploymentKey;

    if (encryptionKey === null) {
      input.logger.error(
        'Refusing to use the deployment key for a workspace with its own key',
        undefined,
        { workspaceId, reason: 'noEncryptionKey' },
      );
      throw new WorkspaceKeyUnreadableError('noEncryptionKey');
    }

    let apiKey: string;
    try {
      apiKey = decryptCredential({
        key: encryptionKey,
        purpose: 'AI_OPENROUTER',
        record: row,
      });
    } catch (error: unknown) {
      // A rotated or damaged row. Falling back to the deployment key would
      // keep the workspace answering on somebody else's account (ADR-023 did
      // that until issue #260); ending the work and saying why lets the owner
      // enter the key again. The cipher's error names no part of the secret.
      input.logger.error(
        'Refusing to use the deployment key for a workspace with its own key',
        error,
        {
          workspaceId,
          reason: 'undecryptable',
        },
      );
      throw new WorkspaceKeyUnreadableError('undecryptable');
    }

    // Best-effort, and deliberately not awaited into the run's critical path:
    // "when was this key last used" is worth a row update, never a failed run.
    void input.prisma.workspaceCredential
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) => {
        input.logger.warn('Could not record when a workspace key was last used', {
          workspaceId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return { apiKey, usedOwnKey: true };
  };
}
