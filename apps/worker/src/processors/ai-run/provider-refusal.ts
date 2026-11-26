import { AI_NO_ELIGIBLE_PROVIDER, isAccountRestriction, isProviderPresetId } from '@exocortex/ai';
import { type AiRunKeyRefusedArgs, type AiRunNoEligibleProviderArgs } from '@exocortex/contracts';

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
 * The refusal an HTTP status says is about the key itself (issue #225): 401
 * for a key the provider does not accept, 402 for an account or key limit
 * with no money left. Anything else is about the request or the provider.
 */
export function keyRefusalReason(status: number | undefined): AiRunKeyRefusedArgs['reason'] | null {
  if (status === 401) return 'invalid';
  if (status === 402) return 'credits';
  return null;
}

/**
 * A turn's failure as the run ends on it, explained where the provider's
 * answer allows it (ADR-059):
 *
 * - a routing refusal gets its diagnosis read from the provider's own
 *   message: whether it named the account's settings is the one thing that
 *   tells the person whose settings to change;
 * - a refused key (issue #225) says whose key and what about it, instead of
 *   "the provider is unavailable", which sends the reader to wait for an
 *   outage that is not there.
 *
 * `servedBy` is the provider whose `start` event opened this turn, which is
 * not the run's own one after a subscription fell back to OpenRouter; empty
 * when none arrived, which leaves the run's own. With whether the workspace
 * has a key of its own it says whose key the refusal was about. Every other
 * failure passes through unchanged.
 */
export function explainProviderRefusal(
  failure: RunFailure,
  input: Pick<RunExecutionInput, 'run' | 'workspaceKey'>,
  servedBy: string,
): RunFailure {
  if (failure.diagnosis !== undefined) return failure;
  const provider = servedBy === '' ? input.run.provider : servedBy;
  const model = input.run.model;
  const ownKey = ownKeyPays(provider, input.workspaceKey);
  if (failure.code === AI_NO_ELIGIBLE_PROVIDER) {
    const cause = isAccountRestriction(failure.message) ? 'account' : 'unknown';
    return noEligibleProviderFailure({ cause, model, ownKey }, failure.message);
  }
  const reason = keyRefusalReason(failure.status);
  if (reason === null) return failure;
  return {
    ...failure,
    diagnosis: {
      key: 'keyRefused',
      args: { reason, provider, model, ownKey },
    },
  };
}
