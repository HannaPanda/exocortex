import { type AiRunReasoningPayload } from '@exocortex/contracts';

import { type RunExecutionInput } from './execution-types';

/**
 * How long reasoning fragments are collected before they go out together.
 *
 * Measured on 2026-10-14 (issue #195): DeepSeek V4.1 Flash streams up to 1400
 * fragments of a few characters each within seconds, on OpenRouter and on
 * Cline alike. One event per fragment would be a few hundred Redis messages
 * and socket frames a second for text nobody reads at that rate; a fifth of a
 * second still reads as live.
 */
export const REASONING_FLUSH_INTERVAL_MS = 200;

type ReasoningBatch = Omit<AiRunReasoningPayload, 'runId' | 'recipientUserId'>;
type Publish = (batch: ReasoningBatch) => Promise<void>;

/**
 * Publishes a run's reasoning batches to its owner only (ADR-087). Never
 * throws: a dropped batch costs the reader a few words of the model's
 * working-out, which nothing depends on, and must not cost the run.
 */
export function reasoningPublisher(
  input: Pick<RunExecutionInput, 'bus' | 'run' | 'payload' | 'logger'>,
): Publish {
  const { bus, run, payload, logger } = input;
  return async (batch) => {
    try {
      await bus.publish({
        type: 'ai.run.reasoning',
        workspaceId: run.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: { runId: run.id, recipientUserId: run.createdById, ...batch },
      });
    } catch (error) {
      logger.warn('Reasoning batch could not be published', {
        runId: run.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Collects a run's reasoning and hands it on in batches (ADR-087).
 *
 * Holds nothing beyond the batch that is waiting: the text is never kept for
 * the run, never written to the row and never logged. `flush` is called
 * whenever anything else happens in the turn (an answer delta, the turn's
 * end), so the reasoning always arrives ahead of what followed it.
 */
export class ReasoningRelay {
  private readonly publish: Publish;
  private readonly now: () => number;
  private pending = '';
  private pendingSince: number | null = null;
  private sequence = 0;
  private turn = 0;

  constructor(publish: Publish, now: () => number = Date.now) {
    this.publish = publish;
    this.now = now;
  }

  /** The provider exchange the following fragments belong to. */
  async startTurn(turn: number): Promise<void> {
    await this.flush();
    this.turn = turn;
  }

  async push(fragment: string): Promise<void> {
    if (fragment.length === 0) return;
    this.pending += fragment;
    this.pendingSince ??= this.now();
    if (this.now() - this.pendingSince >= REASONING_FLUSH_INTERVAL_MS) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const delta = this.pending;
    this.pending = '';
    this.pendingSince = null;
    this.sequence += 1;
    await this.publish({ turn: Math.max(1, this.turn), delta, sequence: this.sequence });
  }
}
