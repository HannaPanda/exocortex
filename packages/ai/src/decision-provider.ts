import { z } from 'zod';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/**
 * A typed semantic decision: yes or no, one of a closed set, or a level on a
 * scale (issue #108).
 *
 * A separate contract from `AiProvider` for the same reason embeddings are
 * one: a decision model generates no text, streams nothing, calls no tools and
 * has no finish reason, and modelling it as a degenerate chat would put every
 * one of those fields on a call that uses none of them. What the caller says
 * is which decision it needs, in eXocortex's words; the wire format of a
 * particular engine (TypeSafe's Jev behind OpenRouter's Decisions API today)
 * stays inside its adapter.
 *
 * Nothing in the product asks this yet. Issue #206 measures it against the
 * keyword tool routing first, and #108 against search reranking and the
 * memory capture gate; a caller is wired up only after a measurement says the
 * decision is worth its round trip. Whoever wires one up owes it a fallback,
 * because a decision engine that is unreachable must never stop a run.
 */

export type DecisionQuestion =
  /** Answered with the probability of "yes". */
  | { kind: 'yesNo'; instructions: string; yes?: string; no?: string }
  /** Answered with one of `options`; name a `none` option when none may fit. */
  | { kind: 'choice'; instructions: string; options: Readonly<Record<string, string>> }
  /** Answered with a level, 0 being the first of 2 to 10 `levels`. */
  | { kind: 'score'; instructions: string; levels: readonly string[] };

export interface DecisionRequest {
  model: string;
  /** What is being judged. Several questions are judged against the same state. */
  state: string | readonly string[] | Readonly<Record<string, unknown>>;
  questions: Readonly<Record<string, DecisionQuestion>>;
  correlationId: string;
  signal?: AbortSignal;
}

export type DecisionAnswer =
  | { kind: 'yesNo'; probability: number }
  | {
      kind: 'choice';
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      /** From the shape of the distribution, not the winner's probability; `null` when not reported. */
      confidence: number | null;
    }
  | {
      kind: 'score';
      /** Probability-weighted level, so 1.4 lies between the second and the third. */
      score: number;
      probabilities: readonly number[];
      confidence: number | null;
    };

export interface DecisionResult {
  /** One answer per question, under the question's key. */
  answers: Readonly<Record<string, DecisionAnswer>>;
  /** The build that answered, which may be more precise than the model asked for. */
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number;
  /** Micro-USD as the provider reported it, `null` when it reports no cost. */
  costMicroUsd: number | null;
}

export interface DecisionProvider {
  readonly id: string;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/** Pinned for evaluation: a moving alias would let two measurements disagree without a cause. */
export const JEV_DECISION_MODEL = 'typesafe/jev-1.13';

const probability = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), probability).optional(),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.array(probability).optional(),
    confidence: probability.optional(),
  }),
]);

const decisionResponseSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().optional(), cost: z.number().optional() }).optional(),
});

export interface OpenRouterDecisionProviderOptions {
  apiKey: string;
  /** The OpenRouter API base, `OPENROUTER_BASE_URL`; the Decisions API lives beside `/v1`. */
  baseUrl: string;
  logger: Logger;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
}

/**
 * OpenRouter's Decisions API (`POST /api/alpha/decisions`).
 *
 * Not the chat-completions transport: the request is a state and a map of
 * questions, the answer a map of distributions. What it shares with the rest
 * of the OpenRouter adapters is the account, so there is no second key and no
 * second bill. The path says alpha, so every answer is validated against the
 * question it belongs to: a missing answer or one of the wrong kind is a
 * refusal, never a default.
 */
export class OpenRouterDecisionProvider implements DecisionProvider {
  public readonly id = 'openrouter';

  constructor(private readonly options: OpenRouterDecisionProviderOptions) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (this.options.apiKey.length === 0) {
      throw new AiProviderError(
        'ai_decision_unavailable',
        'A decision was requested but OPENROUTER_API_KEY is empty.',
      );
    }

    const startedAt = Date.now();
    const response = await fetch(decisionsUrl(this.options.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.options.appUrl,
        'X-Title': 'eXocortex',
      },
      body: JSON.stringify({
        model: request.model,
        state: request.state,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => [key, toWire(question)]),
        ),
      }),
      signal: request.signal ?? null,
    });

    if (!response.ok) {
      const detail = await response.text();
      this.options.logger.error('Decision request failed', undefined, {
        status: response.status,
        model: request.model,
        correlationId: request.correlationId,
      });
      throw new AiProviderError(
        'ai_decision_unavailable',
        `OpenRouter responded with ${response.status}: ${detail.slice(0, 200)}`,
        { status: response.status },
      );
    }

    const parsed = decisionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AiProviderError(
        'ai_decision_invalid',
        'OpenRouter returned a decision response in an unexpected shape.',
      );
    }

    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      const answer = parsed.data.answers[key];
      if (answer === undefined) {
        throw new AiProviderError('ai_decision_invalid', `No answer came back for "${key}".`);
      }
      answers[key] = fromWire(key, question, answer);
    }

    const usage = parsed.data.usage;
    return {
      answers,
      model: parsed.data.model ?? request.model,
      provider: parsed.data.provider ?? this.id,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens ?? 0,
      costMicroUsd: usage?.cost === undefined ? null : Math.round(usage.cost * 1_000_000),
    };
  }
}

/** `https://openrouter.ai/api/v1` becomes `https://openrouter.ai/api/alpha/decisions`. */
export function decisionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/alpha/decisions`;
}

function toWire(question: DecisionQuestion): Record<string, unknown> {
  switch (question.kind) {
    case 'yesNo':
      return {
        type: 'noul',
        instructions: question.instructions,
        ...(question.yes === undefined && question.no === undefined
          ? {}
          : {
              criteria: {
                ...(question.yes === undefined ? {} : { true: question.yes }),
                ...(question.no === undefined ? {} : { false: question.no }),
              },
            }),
      };
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.options };
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.levels };
  }
}

function fromWire(
  key: string,
  question: DecisionQuestion,
  answer: z.infer<typeof answerSchema>,
): DecisionAnswer {
  const mismatch = (): never => {
    throw new AiProviderError(
      'ai_decision_invalid',
      `The answer for "${key}" is a ${answer.type}, the question was ${question.kind}.`,
    );
  };
  switch (question.kind) {
    case 'yesNo':
      return answer.type === 'noul' ? { kind: 'yesNo', probability: answer.noul } : mismatch();
    case 'choice':
      if (answer.type !== 'choice') return mismatch();
      if (!Object.hasOwn(question.options, answer.choice)) {
        throw new AiProviderError(
          'ai_decision_invalid',
          `The answer for "${key}" chose "${answer.choice}", which was not offered.`,
        );
      }
      return {
        kind: 'choice',
        choice: answer.choice,
        probabilities: answer.probabilities ?? {},
        confidence: answer.confidence ?? null,
      };
    case 'score':
      return answer.type === 'score'
        ? {
            kind: 'score',
            score: answer.score,
            probabilities: answer.probabilities ?? [],
            confidence: answer.confidence ?? null,
          }
        : mismatch();
  }
}
