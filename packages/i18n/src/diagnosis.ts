import {
  type AiRunDiagnosis,
  type AiRunIncompleteTurnArgs,
  type AiRunKeyRefusedArgs,
  type AiRunNoEligibleProviderArgs,
  type AiRunTimeoutArgs,
  type AiRunToolLoopArgs,
  type AiRunToolTally,
  parseAiRunDiagnosis,
} from '@exocortex/contracts';

import type { Messages } from './catalog.js';

/**
 * The run diagnosis in the reader's language (issue #98, ADR-059, ADR-062).
 *
 * The worker stores facts, not a sentence; this turns them into the lines the
 * person reads. It lives here rather than in the worker because three readers
 * render it: the worker (German, into `errorDetail`), the API (the requester's
 * locale, for `exo_ai_run_get`) and the browser (the viewer's, from the socket
 * event). Each hands in its own translator for the `diagnostics` namespace, so
 * this file imports no catalogue and stays safe for a client bundle.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type DiagnosisMessageKey = Leaves<Messages['diagnostics']>;

/** Satisfied by `useTranslations('diagnostics')` and `serverTranslator(locale, 'diagnostics')`. */
export type DiagnosisTranslator = (
  key: DiagnosisMessageKey,
  values?: Record<string, string | number>,
) => string;

/** Tools named in the tool-loop diagnosis; the rest are counted, not listed. */
const MAX_LISTED_TOOLS = 5;

export function renderAiRunDiagnosis(t: DiagnosisTranslator, diagnosis: AiRunDiagnosis): string {
  switch (diagnosis.key) {
    case 'toolLoop':
      return renderToolLoop(t, diagnosis.args);
    case 'runTimeout':
      return renderRunTimeout(t, diagnosis.args);
    case 'incompleteTurn':
      return renderIncompleteTurn(t, diagnosis.args);
    case 'noEligibleProvider':
      return renderNoEligibleProvider(t, diagnosis.args);
    case 'keyRefused':
      return renderKeyRefused(t, diagnosis.args);
  }
}

/**
 * The text a reader shows for a failed run: key and arguments when it knows
 * them, the stored rendering otherwise. A row older than the columns, or a key
 * newer than this reader, lands on the second branch.
 */
export function aiRunDiagnosisText(
  t: DiagnosisTranslator,
  run: { errorDetail: string | null; errorDetailKey: string | null; errorDetailArgs: unknown },
): string | null {
  const diagnosis = parseAiRunDiagnosis(run.errorDetailKey, run.errorDetailArgs);
  return diagnosis === null ? run.errorDetail : renderAiRunDiagnosis(t, diagnosis);
}

/**
 * Why the run ran out of tool calls, in the words of what it actually did:
 * which tools, how much they returned, how many calls answered nothing new,
 * and the way in that would have worked.
 */
function renderToolLoop(t: DiagnosisTranslator, args: AiRunToolLoopArgs): string {
  const calls = args.tallies.reduce((total, tally) => total + tally.calls, 0);
  const repeats = args.tallies.reduce((total, tally) => total + tally.repeats, 0);
  const chars = args.tallies.reduce((total, tally) => total + tally.chars, 0);

  const lines = [t('toolLoop.limitReached', { limit: args.limit })];
  if (calls === 0) {
    lines.push(t('toolLoop.noCalls'));
    return lines.join('\n');
  }

  lines.push(t('toolLoop.summary', { calls, chars }));
  for (const tally of args.tallies.slice(0, MAX_LISTED_TOOLS)) {
    lines.push(`- ${describeTally(t, tally)}`);
  }
  const hidden = args.tallies.length - MAX_LISTED_TOOLS;
  if (hidden > 0) lines.push(`- ${t('toolLoop.moreTools', { count: hidden })}`);

  if (repeats > 0) lines.push(t('toolLoop.repeats', { repeats }));
  lines.push(t('toolLoop.wayIn'));
  return lines.join('\n');
}

function describeTally(t: DiagnosisTranslator, tally: AiRunToolTally): string {
  const values = { name: tally.name, calls: tally.calls, chars: tally.chars };
  return tally.repeats > 0
    ? t('toolLoop.toolWithRepeats', { ...values, repeats: tally.repeats })
    : t('toolLoop.tool', values);
}

/**
 * Why the run ran out of time: which of the two limits, at which thinking
 * level, and whether the time went into thinking rather than into writing --
 * the facts that decide whether the answer is a higher limit (rarely) or a
 * lower level.
 */
function renderRunTimeout(t: DiagnosisTranslator, args: AiRunTimeoutArgs): string {
  const duration = durationOf(t, args.limitMs);
  const effort = t(`runTimeout.effort.${args.effort}`);
  const lines = [
    args.limit === 'turn'
      ? t('runTimeout.turnLimit', { duration })
      : t('runTimeout.runLimit', { duration }),
    args.toolIterations === 0
      ? t('runTimeout.ran', { model: args.model, effort })
      : t('runTimeout.ranAfterRounds', {
          model: args.model,
          effort,
          rounds: args.toolIterations,
        }),
  ];

  if (args.turnChars > 0) lines.push(t('runTimeout.received', { chars: args.turnChars }));
  else if (args.sawReasoning) lines.push(t('runTimeout.thoughtOnly'));
  else lines.push(t('runTimeout.nothing'));

  if (args.effort !== 'none' && args.turnChars === 0) lines.push(t('runTimeout.hintEffort'));
  else if (args.limit === 'run') lines.push(t('runTimeout.hintRun'));
  else lines.push(t('runTimeout.hintSmaller'));
  return lines.join('\n');
}

/**
 * Why a turn came back with nothing: whether the provider broke off or
 * finished empty, what had arrived by then, and that the work so far is kept,
 * which is what decides that "weiter" is the next thing to type.
 */
function renderIncompleteTurn(t: DiagnosisTranslator, args: AiRunIncompleteTurnArgs): string {
  const effort = t(`runTimeout.effort.${args.effort}`);
  const lines = [
    args.interrupted ? t('incompleteTurn.interrupted') : t('incompleteTurn.empty'),
    args.toolIterations === 0
      ? t('runTimeout.ran', { model: args.model, effort })
      : t('runTimeout.ranAfterRounds', { model: args.model, effort, rounds: args.toolIterations }),
  ];
  if (args.turnChars > 0) lines.push(t('incompleteTurn.received', { chars: args.turnChars }));
  else if (args.sawReasoning) lines.push(t('incompleteTurn.thoughtOnly'));
  else if (args.interrupted) lines.push(t('incompleteTurn.nothing'));
  lines.push(t('incompleteTurn.attempts', { attempts: args.attempts }));
  lines.push(t('incompleteTurn.hint'));
  return lines.join('\n');
}

/**
 * Why nobody served the model, and who can change that: a request that is too
 * large is the reader's to shrink, an account restriction belongs to whoever
 * owns the key, and an unexplained refusal usually passes on its own.
 */
function renderNoEligibleProvider(
  t: DiagnosisTranslator,
  args: AiRunNoEligibleProviderArgs,
): string {
  const values = { model: args.model };
  switch (args.cause) {
    case 'size':
      return [t('noEligibleProvider.size', values), t('noEligibleProvider.hintSize')].join('\n');
    case 'account':
      return [
        t('noEligibleProvider.account', values),
        args.ownKey
          ? t('noEligibleProvider.hintOwnKey', values)
          : t('noEligibleProvider.hintDeploymentKey'),
      ].join('\n');
    case 'unknown':
      return [t('noEligibleProvider.unknown', values), t('noEligibleProvider.hintUnknown')].join(
        '\n',
      );
  }
}

/**
 * Why the provider refused the key (issue #225): which key, what about it,
 * and who can fix it. For a workspace's own key it also says that no other
 * key stepped in, because that is the question a person paying for their own
 * runs asks next.
 */
function renderKeyRefused(t: DiagnosisTranslator, args: AiRunKeyRefusedArgs): string {
  const values = { provider: args.provider, model: args.model };
  const whose = args.ownKey ? 'OwnKey' : 'DeploymentKey';
  const headline = t(`keyRefused.${args.reason}${whose}`, values);
  const hint = t(`keyRefused.hint${whose}`, values);
  return [headline, hint].join('\n');
}

/** Whole seconds, or whole minutes once that is the honest unit. */
function durationOf(t: DiagnosisTranslator, limitMs: number): string {
  const total = Math.round(limitMs / 1_000);
  if (total < 120) return t('runTimeout.seconds', { count: total });
  return t('runTimeout.minutes', { count: Math.round(total / 60) });
}
