import { decryptCredential, parseCredentialKey } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
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
 * one; the deployment-wide machinery around it (search embeddings, cover
 * images, memory capture and consolidation) stays on the deployment key.
 * Embeddings must, under ADR-020: index and query have to live in one vector
 * space, and two accounts embedding under two keys against one index is the
 * failure that looks exactly like a healthy deployment finding nothing.
 */

export interface ResolvedAiKey {
  apiKey: string;
  /** Whether the key above is the workspace's own. Recorded on the run. */
  usedOwnKey: boolean;
}

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
  // worker from booting, it simply means no workspace key can be read.
  let encryptionKey: Buffer | null = null;
  try {
    encryptionKey = parseCredentialKey(input.env.CREDENTIAL_ENCRYPTION_KEY);
  } catch (error: unknown) {
    input.logger.error('Ignoring CREDENTIAL_ENCRYPTION_KEY: it is not usable', error);
  }

  return async (workspaceId: string): Promise<ResolvedAiKey> => {
    if (encryptionKey === null) return deploymentKey;

    const row = await input.prisma.workspaceCredential.findUnique({
      where: { workspaceId_purpose: { workspaceId, purpose: 'AI_OPENROUTER' } },
    });
    if (row === null) return deploymentKey;

    let apiKey: string;
    try {
      apiKey = decryptCredential({
        key: encryptionKey,
        purpose: 'AI_OPENROUTER',
        record: row,
      });
    } catch (error: unknown) {
      // A key that cannot be decrypted is a rotated or corrupted row, not a
      // reason to fail the run: falling back to the deployment key keeps the
      // workspace working, and `usedOwnKey: false` keeps the usage report
      // honest about who paid.
      input.logger.error('Falling back to the deployment key for this workspace', error, {
        workspaceId,
      });
      return deploymentKey;
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
