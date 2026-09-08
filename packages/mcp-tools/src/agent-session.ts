import { z } from 'zod';

import {
  type AgentSessionTransport,
  registerAgentSessionRequestSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient } from './client.js';

/**
 * The connection's own identity, announced once at `initialize` (ADR-022).
 *
 * Everything else in this package answers a call; this is the one thing that
 * has to happen before any call, because "what did this agent do this
 * afternoon" is a question no per-request identifier can answer. The id is
 * minted by whichever transport owns the connection and carried on every
 * request from then on by `ExocortexApiClient.setAgentSession`.
 */

const registerResponseSchema = z.object({ id: z.string(), externalId: z.string() });

/** `clientInfo` as `initialize` carries it. Unverified: a client names itself. */
export function clientLabelFrom(params: Record<string, unknown>): string | undefined {
  const info = params.clientInfo;
  if (typeof info !== 'object' || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') return undefined;
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  return (version === '' ? name : `${name} ${version}`).slice(0, 200);
}

/**
 * Registers the session and stamps it on every subsequent request.
 *
 * Failure is swallowed on purpose. Provenance is bookkeeping around the work,
 * never a precondition for it: a handshake that fell over because the journal
 * was unavailable would make the whole deployment depend on a feature whose
 * entire job is to be quietly correct in the background. The client is stamped
 * regardless, so writes are still grouped even when this call did not land --
 * the API creates the row it needs on the first write it journals.
 */
export async function announceAgentSession(input: {
  client: ExocortexApiClient;
  externalId: string;
  transport: AgentSessionTransport;
  label?: string;
  onError?: (reason: string) => void;
}): Promise<void> {
  input.client.setAgentSession?.({ externalId: input.externalId, label: input.label });
  try {
    await input.client.request({
      method: 'POST',
      path: '/api/agent-sessions',
      body: registerAgentSessionRequestSchema.parse({
        externalId: input.externalId,
        clientLabel: input.label,
        transport: input.transport,
      }),
      responseSchema: registerResponseSchema,
    });
  } catch (error) {
    input.onError?.(error instanceof Error ? error.message : String(error));
  }
}
