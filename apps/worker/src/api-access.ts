import { issueServiceToken } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
import { type Logger } from '@exocortex/logger';
import { createFetchApiClient, type ExocortexApiClient } from '@exocortex/mcp-tools';

import {
  createToolRunner,
  type ToolRunnerFactory,
  type ToolRunnerFactoryInput,
} from './tool-runner';

/**
 * The two ways the worker reaches the REST API as a person (ADR-014): the AI
 * tool loop, and a processor that writes through the API rather than the
 * database. Both hang off `SERVICE_TOKEN_SECRET`, and both are null without
 * it (split out of `runtime.ts`, issue #97).
 */

/**
 * The per-run half of the tool loop, bound to the deployment-wide half.
 *
 * `SERVICE_TOKEN_SECRET` is optional, so an unset secret returns `null` and
 * disables tools rather than crashing boot (R2).
 */
export function buildToolRunnerFactory(env: WorkerEnv, logger: Logger): ToolRunnerFactory | null {
  if (env.SERVICE_TOKEN_SECRET === undefined) return null;
  const serviceTokenSecret = env.SERVICE_TOKEN_SECRET;
  return (input: ToolRunnerFactoryInput) =>
    createToolRunner({
      apiUrl: env.API_URL,
      serviceTokenSecret,
      serviceTokenTtlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
      userId: input.userId,
      includeMutating: input.includeMutating,
      mutationPolicy: input.mutationPolicy,
      webFetchesPerRun: input.webFetchesPerRun,
      taskText: input.taskText,
      requiredDomains: input.requiredDomains,
      toolCallTimeoutMs: input.toolCallTimeoutMs,
      agentSession: input.agentSession,
      logger,
    });
}

/**
 * An API client acting as one particular human, for a processor that has to
 * write through the REST API rather than the database (ADR-014).
 *
 * Same seam as the tool loop above: no secret means no client, and the
 * processor reports the feature as unavailable instead of failing per job. A
 * token is minted per call because a job is rare and short, unlike the tool
 * loop's many calls inside one run.
 */
export function buildApiClientFactory(
  env: WorkerEnv,
): ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null {
  if (env.SERVICE_TOKEN_SECRET === undefined) return null;
  const serviceTokenSecret = env.SERVICE_TOKEN_SECRET;
  return (userId, headers) =>
    createFetchApiClient({
      baseUrl: env.API_URL,
      token: issueServiceToken({
        secret: serviceTokenSecret,
        userId,
        purpose: 'ai-tools',
        ttlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
      }).token,
      // The one caller that passes headers is the automation processor,
      // stamping the rule its write came from so the write cannot trigger
      // that rule again (issue #50, ADR-024). The API accepts that header
      // only on a service token, which is the only kind minted here.
      headers,
    });
}
