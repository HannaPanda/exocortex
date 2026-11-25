import { AI_NO_ELIGIBLE_PROVIDER, isAccountRestriction, isProviderPresetId } from '@exocortex/ai';
import { type AiRunNoEligibleProviderArgs } from '@exocortex/contracts';

import { type RunFailure } from './contract';
import { type RunExecutionInput } from './execution-types';

/**
 * Whether the workspace's own key pays for an answer served by `provider`.
 *
 * The workspace key is an OpenRouter key, so it pays only what OpenRouter
 * serves. A run on a subscription preset (issue #187) is paid by the
 * deployment's plan, even though the workspace key is resolved for it, because
 * the same run may fall back to OpenRouter and that turn is the workspace's.
 * Recording the resolved key instead of the paying one made every Cline run of
 * a workspace with a key count as the workspace's spending.
 */
export function ownKeyPays(provider: string, workspaceKey: boolean): boolean {
  return workspaceKey && !isProviderPresetId(provider);
}

/**
 * Whether the workspace's own key has paid for a turn of one run, kept true
 * on the row. `markRunning` wrote who pays for the run's own provider; `note`
 * only ever widens that, the first time a turn is served by a provider the
 * key pays for: a subscription turn that fell back to OpenRouter (issue #187).
 * Best effort, because a missed flag misreports a bill and must never fail
 * the answer.
 */
export class OwnKeyPayer {
  paid: boolean;

  constructor(
    private readonly input: Pick<RunExecutionInput, 'prisma' | 'run' | 'logger' | 'workspaceKey'>,
  ) {
    this.paid = ownKeyPays(input.run.provider, input.workspaceKey);
  }

  async note(servedBy: string): Promise<void> {
    if (this.paid || !ownKeyPays(servedBy, this.input.workspaceKey)) return;
    this.paid = true;
    await this.input.prisma.aiRun
      .update({ where: { id: this.input.run.id }, data: { usedOwnKey: true } })
      .catch((error: unknown) => {
        this.input.logger.warn('Could not record that the workspace key paid a fallback turn', {
          runId: this.input.run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/**
 * The failure for a run that nobody would serve, carrying why and who can
 * change it, so the reader sees more than "no answer" (ADR-059).
 */
export function noEligibleProviderFailure(
  args: AiRunNoEligibleProviderArgs,
  message: string,
): RunFailure {
  return {
    code: AI_NO_ELIGIBLE_PROVIDER,
    message,
    diagnosis: { key: 'noEligibleProvider', args: { ...args } },
  };
}

/**
 * A turn's failure as the run ends on it. A provider's routing refusal gets
 * its diagnosis here, read from the provider's own message: whether it named
 * the account's settings is the one thing that tells the person whose
 * settings to change. Every other failure passes through unchanged.
 */
export function explainProviderRefusal(
  failure: RunFailure,
  model: string,
  ownKey: boolean,
): RunFailure {
  if (failure.code !== AI_NO_ELIGIBLE_PROVIDER || failure.diagnosis !== undefined) return failure;
  const cause = isAccountRestriction(failure.message) ? 'account' : 'unknown';
  return noEligibleProviderFailure({ cause, model, ownKey }, failure.message);
}
