import { AiProviderError, type DecisionProvider, JEV_DECISION_MODEL } from '@exocortex/ai';
import {
  type AiRunToolRoutingEventData,
  type ToolRoutingFallbackReason,
  type ToolRoutingSignal,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import {
  domainsFromProbabilities,
  ROUTING_TIMEOUT_MS,
  routingQuestions,
  routingState,
  selectToolDomains,
  type ToolDomain,
} from '@exocortex/mcp-tools';

export interface ToolRoutingInput {
  /** `ai.semanticToolRouting`, as resolved for the run's workspace. */
  enabled: boolean;
  /** The person's own words (`taskTextFor`), the only text that leaves the deployment. */
  text: string;
  /** Domains needed whatever the words say: an open database view, a proposing run, carried ones. */
  required: readonly ToolDomain[];
  /** What the conversation's last runs reached for; part of `required`, recorded on its own. */
  carried: readonly ToolDomain[];
  /** What the open page carries, known without asking anybody. */
  signals: readonly ToolRoutingSignal[];
  /** `null` when this deployment has no OpenRouter key to ask with. */
  decisions: DecisionProvider | null;
  correlationId: string;
  logger: Logger;
  timeoutMs?: number;
}

export interface ToolRoutingOutcome {
  domains: ToolDomain[];
  /** What the run inspector records about the choice: facts, never the text. */
  event: AiRunToolRoutingEventData;
  durationMs: number | null;
}

/** The domains a page signal makes necessary before anybody names them. */
function signalDomains(signals: readonly ToolRoutingSignal[]): ToolDomain[] {
  return signals.length > 0 ? ['attachments'] : [];
}

/**
 * Chooses the tool domains a run starts with (issue #206, ADR-089).
 *
 * Switched off, this is the keyword selection exactly as before. Switched on,
 * Jev decides: one yes/no question per domain, answered together in one call,
 * and everything at or above the measured threshold is offered. Any way that
 * call can go wrong (no key, a timeout, an error, an answer without
 * probabilities) ends in the keyword selection and a run that starts anyway;
 * the reason is recorded, never thrown.
 *
 * Neither path is a permission (ADR-060). `core`, `pages` and `exo_toolbox`
 * are always offered, and an unoffered tool stays executable.
 */
export async function routeToolDomains(input: ToolRoutingInput): Promise<ToolRoutingOutcome> {
  const required = [...new Set([...input.required, ...signalDomains(input.signals)])];
  const keywords = (): ToolDomain[] => selectToolDomains({ text: input.text, required });
  const facts = { carried: [...input.carried], signals: [...input.signals] };

  if (!input.enabled || input.text.trim().length === 0) {
    return {
      domains: keywords(),
      durationMs: null,
      event: {
        decider: 'keywords',
        fallbackReason: null,
        domains: keywords(),
        model: null,
        costMicroUsd: null,
        ...facts,
      },
    };
  }

  const fallback = (
    reason: ToolRoutingFallbackReason,
    durationMs: number | null,
  ): ToolRoutingOutcome => {
    const domains = keywords();
    return {
      domains,
      durationMs,
      event: {
        decider: 'fallback',
        fallbackReason: reason,
        domains,
        model: null,
        costMicroUsd: null,
        ...facts,
      },
    };
  };

  if (input.decisions === null) return fallback('unavailable', null);

  const started = Date.now();
  try {
    const result = await input.decisions.decide({
      model: JEV_DECISION_MODEL,
      state: routingState(input.text, {
        pageAttachments: input.signals.map((signal) =>
          signal === 'page_images' ? 'image' : 'pdf',
        ),
      }),
      questions: routingQuestions(),
      correlationId: input.correlationId,
      signal: AbortSignal.timeout(input.timeoutMs ?? ROUTING_TIMEOUT_MS),
    });
    const probabilities: Record<string, number> = {};
    for (const [domain, answer] of Object.entries(result.answers)) {
      if (answer.kind === 'yesNo') probabilities[domain] = answer.probability;
    }
    if (Object.keys(probabilities).length === 0) return fallback('empty', Date.now() - started);
    const domains = domainsFromProbabilities(probabilities, required);
    return {
      domains,
      durationMs: Date.now() - started,
      event: {
        decider: 'jev',
        fallbackReason: null,
        domains,
        model: result.model,
        costMicroUsd: result.costMicroUsd,
        ...facts,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const reason = fallbackReasonFor(error);
    input.logger.warn('Tool routing fell back to keywords', {
      correlationId: input.correlationId,
      reason,
      durationMs,
      detail: error instanceof Error ? error.message : String(error),
    });
    return fallback(reason, durationMs);
  }
}

/** Which way the call went wrong, as the closed list the inspector words. */
function fallbackReasonFor(error: unknown): ToolRoutingFallbackReason {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  if (error instanceof AiProviderError && error.code === 'ai_decision_invalid') return 'invalid';
  return 'error';
}
